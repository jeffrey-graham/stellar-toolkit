import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  Transaction,
} from 'stellar-sdk';
import { AccountInfo, Balance, MultiSigConfig } from '../types';
import { Server } from '../utils/network';
import {
  AccountNotFoundError,
  NetworkConnectionError,
  NetworkTimeoutError,
  ToolkitError,
  ValidationError,
} from '../errors';

export type AccountResponse = Horizon.AccountResponse;

export const MAX_STELLAR_SIGNERS = 20;

export class AccountManager {
  constructor(
    private server: Server,
    private networkPassphrase = 'Test SDF Network ; September 2015',
  ) {}

  private mapAccountLookupError(publicKey: string, error: unknown): Error {
    if (error instanceof AccountNotFoundError) {
      return error;
    }

    const errObj = error as {
      name?: string;
      code?: string;
      message?: string;
      status?: number;
      statusCode?: number;
      response?: { status?: number; statusCode?: number; statusText?: string };
    };

    const status =
      errObj?.response?.status ??
      errObj?.response?.statusCode ??
      errObj?.status ??
      errObj?.statusCode;
    const code = errObj?.code ?? '';
    const name = errObj?.name ?? '';
    const rawMessage =
      error instanceof Error
        ? error.message
        : typeof errObj?.message === 'string'
          ? errObj.message
          : String(error);

    if (
      status === 404 ||
      name === 'NotFoundError' ||
      (code !== 'ENOTFOUND' &&
        typeof status !== 'number' &&
        (/\b404\b/.test(rawMessage) || /\bnot found\b/i.test(rawMessage)))
    ) {
      return new AccountNotFoundError(publicKey);
    }

    if (error instanceof ToolkitError) {
      return error;
    }

    const serverUrl =
      (
        this.server as unknown as {
          serverURL?: { toString(): string };
        }
      )?.serverURL?.toString?.() || 'horizon';

    if (
      typeof status !== 'number' &&
      (code === 'ETIMEDOUT' ||
        code === 'ECONNABORTED' ||
        name === 'TimeoutError' ||
        /timed?\s*out/i.test(rawMessage))
    ) {
      return new NetworkTimeoutError(serverUrl);
    }

    if (
      (typeof status === 'number' && status >= 500) ||
      [
        'ECONNREFUSED',
        'ENOTFOUND',
        'ECONNRESET',
        'EAI_AGAIN',
        'ENETUNREACH',
        'EHOSTUNREACH',
      ].includes(code) ||
      /econnrefused|enotfound|econnreset|network|connection|unreachable|\b5\d\d\b|internal server error|bad gateway|service unavailable/i.test(
        rawMessage,
      )
    ) {
      const detail =
        typeof status === 'number'
          ? `HTTP ${status}${rawMessage ? `: ${rawMessage}` : ''}`
          : rawMessage;
      return new NetworkConnectionError(serverUrl, detail);
    }

    return new Error(`Failed to load account ${publicKey}: ${rawMessage}`);
  }

  /**
   * Generate a new Stellar keypair
   */
  generateKeypair(): AccountInfo {
    const pair = Keypair.random();
    return {
      publicKey: pair.publicKey(),
      secret: pair.secret(),
    };
  }

  /**
   * Load account from the network
   */
  async loadAccount(publicKey: string): Promise<AccountResponse> {
    try {
      return await this.server.loadAccount(publicKey);
    } catch (error: unknown) {
      throw this.mapAccountLookupError(publicKey, error);
    }
  }

  /**
   * Get account balances
   */
  async getBalances(publicKey: string): Promise<Balance[]> {
    const account = await this.loadAccount(publicKey);
    return account.balances as Balance[];
  }

  /**
   * Check if account exists on the network
   */
  async accountExists(publicKey: string): Promise<boolean> {
    try {
      await this.loadAccount(publicKey);
      return true;
    } catch (error: unknown) {
      if (error instanceof AccountNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get account native balance
   */
  async getNativeBalance(publicKey: string): Promise<string> {
    const balances = await this.getBalances(publicKey);
    const nativeBalance = balances.find((b) => b.asset_type === 'native');
    return nativeBalance?.balance || '0';
  }

  /**
   * Fund account on testnet using Friendbot
   */
  async fundTestnetAccount(publicKey: string): Promise<void> {
    try {
      const response = await fetch(
        `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`,
      );
      if (!response.ok) {
        throw new Error(`Friendbot request failed: ${response.statusText}`);
      }
    } catch (error) {
      throw new Error(`Failed to fund testnet account: ${error}`);
    }
  }

  /**
   * Validate a multi-signature configuration
   */
  validateMultiSigConfig(config: MultiSigConfig): void {
    if (!config.signers || config.signers.length === 0) {
      throw new ValidationError('signers', 'At least one signer is required');
    }
    if (config.signers.length > MAX_STELLAR_SIGNERS) {
      throw new ValidationError(
        'signers',
        `Cannot exceed ${MAX_STELLAR_SIGNERS} signers per account`,
      );
    }

    const masterWeight = config.masterWeight ?? 1;
    if (!Number.isInteger(masterWeight) || masterWeight < 0 || masterWeight > 255) {
      throw new ValidationError('masterWeight', 'Weight out of range (must be 0-255)');
    }

    let totalWeight = masterWeight;
    for (const signer of config.signers) {
      if (!Number.isInteger(signer.weight) || signer.weight < 0 || signer.weight > 255) {
        throw new ValidationError('weight', 'Weight out of range (must be 0-255)');
      }
      totalWeight += signer.weight;
    }

    const { low, medium, high } = config.thresholds;
    for (const [name, value] of Object.entries({ low, medium, high })) {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new ValidationError(name, 'Threshold out of range (must be 0-255)');
      }
    }

    const maxThreshold = Math.max(low, medium, high);
    if (maxThreshold > totalWeight) {
      throw new ValidationError(
        'thresholds',
        `Threshold too high: max threshold (${maxThreshold}) exceeds total available signer weight (${totalWeight})`,
      );
    }
  }

  /**
   * Configure a multi-signature account with signers and thresholds
   */
  async configureMultiSig(config: MultiSigConfig): Promise<string> {
    this.validateMultiSigConfig(config);

    const masterKeypair = Keypair.fromSecret(config.masterSecret);
    const sourceAccount = await this.server.loadAccount(masterKeypair.publicKey());

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    for (const signer of config.signers) {
      builder.addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: signer.publicKey,
            weight: signer.weight,
          },
        }),
      );
    }

    builder.addOperation(
      Operation.setOptions({
        masterWeight: config.masterWeight ?? 1,
        lowThreshold: config.thresholds.low,
        medThreshold: config.thresholds.medium,
        highThreshold: config.thresholds.high,
      }),
    );

    const tx = builder.setTimeout(180).build();
    tx.sign(masterKeypair);

    const result = await this.server.submitTransaction(tx);
    return result.hash;
  }

  /**
   * Add or update a signer on an account
   */
  async addSigner(masterSecret: string, signerPublicKey: string, weight: number): Promise<string> {
    if (!Number.isInteger(weight) || weight <= 0 || weight > 255) {
      throw new ValidationError('weight', 'Weight out of range (must be 1-255)');
    }

    const masterKeypair = Keypair.fromSecret(masterSecret);
    const sourceAccount = await this.server.loadAccount(masterKeypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: signerPublicKey,
            weight,
          },
        }),
      )
      .setTimeout(180)
      .build();

    tx.sign(masterKeypair);
    const result = await this.server.submitTransaction(tx);
    return result.hash;
  }

  /**
   * Remove a signer from an account (sets weight to 0)
   */
  async removeSigner(masterSecret: string, signerPublicKey: string): Promise<string> {
    const masterKeypair = Keypair.fromSecret(masterSecret);
    const sourceAccount = await this.server.loadAccount(masterKeypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: signerPublicKey,
            weight: 0,
          },
        }),
      )
      .setTimeout(180)
      .build();

    tx.sign(masterKeypair);
    const result = await this.server.submitTransaction(tx);
    return result.hash;
  }

  /**
   * Sign a transaction with multiple signers and verify threshold satisfaction
   */
  signMultiSigTransaction(
    transaction: Transaction,
    signerSecrets: string[],
    requiredThreshold = 1,
    signerWeights?: Record<string, number>,
  ): Transaction {
    const uniqueSecrets = Array.from(new Set(signerSecrets));
    let accumulatedWeight = 0;

    for (const secret of uniqueSecrets) {
      const kp = Keypair.fromSecret(secret);
      const weight = signerWeights ? (signerWeights[kp.publicKey()] ?? 1) : 1;
      accumulatedWeight += weight;
      transaction.sign(kp);
    }

    if (accumulatedWeight < requiredThreshold) {
      throw new Error(
        `Insufficient signatures: accumulated weight ${accumulatedWeight} is below required threshold ${requiredThreshold}`,
      );
    }

    return transaction;
  }
}
