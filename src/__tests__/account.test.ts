import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from 'stellar-sdk';
import { NetworkConnectionError, NetworkTimeoutError, StellarToolkit } from '../index';

describe('StellarToolkit - Account & Multi-Sig Operations', () => {
  let toolkit: StellarToolkit;

  beforeEach(() => {
    toolkit = new StellarToolkit({ network: 'testnet' });
  });

  describe('generateKeypair', () => {
    it('should generate a valid keypair', () => {
      const keypair = toolkit.generateKeypair();

      expect(keypair).toHaveProperty('publicKey');
      expect(keypair).toHaveProperty('secret');
      expect(keypair.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
      expect(keypair.secret).toMatch(/^S[A-Z2-7]{55}$/);
    });

    it('should generate unique keypairs', () => {
      const keypair1 = toolkit.generateKeypair();
      const keypair2 = toolkit.generateKeypair();

      expect(keypair1.publicKey).not.toBe(keypair2.publicKey);
      expect(keypair1.secret).not.toBe(keypair2.secret);
    });
  });

  describe('accountExists', () => {
    it('should return true for an existing account', async () => {
      const keypair = toolkit.generateKeypair();
      const server = (toolkit as unknown as { server: { loadAccount: jest.Mock } }).server;
      jest
        .spyOn(server, 'loadAccount')
        .mockResolvedValueOnce(new Account(keypair.publicKey, '100') as unknown as never);

      const exists = await toolkit.accountExists(keypair.publicKey);
      expect(exists).toBe(true);
    });

    it('should return false for a confirmed 404 Not Found response', async () => {
      const keypair = toolkit.generateKeypair();
      const server = (toolkit as unknown as { server: { loadAccount: jest.Mock } }).server;
      jest.spyOn(server, 'loadAccount').mockRejectedValueOnce({
        response: { status: 404 },
        message: 'Resource Missing',
      });

      const exists = await toolkit.accountExists(keypair.publicKey);
      expect(exists).toBe(false);
    });

    it('should return false for a 404 Not Found error message', async () => {
      const keypair = toolkit.generateKeypair();
      const server = (toolkit as unknown as { server: { loadAccount: jest.Mock } }).server;
      jest.spyOn(server, 'loadAccount').mockRejectedValueOnce(new Error('404 Not Found'));

      const exists = await toolkit.accountExists(keypair.publicKey);
      expect(exists).toBe(false);
    });

    it('should reject with NetworkTimeoutError on Horizon timeout', async () => {
      const keypair = toolkit.generateKeypair();
      const server = (toolkit as unknown as { server: { loadAccount: jest.Mock } }).server;
      jest.spyOn(server, 'loadAccount').mockRejectedValueOnce(
        Object.assign(new Error('Request timed out after 5000ms'), {
          code: 'ETIMEDOUT',
        }),
      );

      await expect(toolkit.accountExists(keypair.publicKey)).rejects.toThrow(NetworkTimeoutError);
    });

    it('should reject with NetworkConnectionError on connection failure (ECONNREFUSED / ENOTFOUND)', async () => {
      const keypair = toolkit.generateKeypair();
      const server = (toolkit as unknown as { server: { loadAccount: jest.Mock } }).server;
      jest.spyOn(server, 'loadAccount').mockRejectedValueOnce(
        Object.assign(new Error('getaddrinfo ENOTFOUND horizon-testnet.stellar.org'), {
          code: 'ENOTFOUND',
        }),
      );

      await expect(toolkit.accountExists(keypair.publicKey)).rejects.toThrow(
        NetworkConnectionError,
      );
    });

    it('should reject with NetworkConnectionError on Horizon 5xx server error', async () => {
      const keypair = toolkit.generateKeypair();
      const server = (toolkit as unknown as { server: { loadAccount: jest.Mock } }).server;
      jest.spyOn(server, 'loadAccount').mockRejectedValueOnce({
        response: { status: 503 },
        message: 'Service Unavailable',
      });

      await expect(toolkit.accountExists(keypair.publicKey)).rejects.toThrow(
        NetworkConnectionError,
      );
    });
  });

  describe('formatAsset', () => {
    it('should format native asset', () => {
      const formatted = toolkit.formatAsset('native');
      expect(formatted).toBe('XLM');
    });

    it('should format custom asset', () => {
      const formatted = toolkit.formatAsset({
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      });
      expect(formatted).toContain('USDC');
    });
  });

  describe('Multi-Signature Support', () => {
    const mockAccountServer = (tk: StellarToolkit, pubKey: string) => {
      const server = (
        tk as unknown as {
          server: { loadAccount: jest.Mock; submitTransaction: jest.Mock };
        }
      ).server;
      jest
        .spyOn(server, 'loadAccount')
        .mockResolvedValue(new Account(pubKey, '100') as unknown as never);
      jest
        .spyOn(server, 'submitTransaction')
        .mockResolvedValue({ hash: 'multisig_tx_hash_123' } as unknown as never);
      return server;
    };

    it('test_multisig_creation_2of3', async () => {
      const master = Keypair.random();
      const signer2 = Keypair.random();
      const signer3 = Keypair.random();
      mockAccountServer(toolkit, master.publicKey());

      const txHash = await toolkit.configureMultiSig({
        masterSecret: master.secret(),
        masterWeight: 1,
        signers: [
          { publicKey: signer2.publicKey(), weight: 1 },
          { publicKey: signer3.publicKey(), weight: 1 },
        ],
        thresholds: { low: 1, medium: 2, high: 2 },
      });

      expect(txHash).toBe('multisig_tx_hash_123');
    });

    it('test_multisig_signing_sufficient', () => {
      const s1 = Keypair.random();
      const s2 = Keypair.random();
      const dest = Keypair.random();
      const account = new Account(s1.publicKey(), '101');
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: dest.publicKey(),
            asset: Asset.native(),
            amount: '10',
          }),
        )
        .setTimeout(180)
        .build();

      const signed = toolkit.signMultiSigTransaction(tx, [s1.secret(), s2.secret()], 2);
      expect(signed.signatures.length).toBe(2);
    });

    it('test_multisig_signing_insufficient', () => {
      const s1 = Keypair.random();
      const dest = Keypair.random();
      const account = new Account(s1.publicKey(), '101');
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: dest.publicKey(),
            asset: Asset.native(),
            amount: '10',
          }),
        )
        .setTimeout(180)
        .build();

      expect(() => toolkit.signMultiSigTransaction(tx, [s1.secret()], 2)).toThrow(
        /Insufficient signatures/i,
      );
    });

    it('test_threshold_validation', async () => {
      const master = Keypair.random();
      const signer2 = Keypair.random();

      await expect(
        toolkit.configureMultiSig({
          masterSecret: master.secret(),
          masterWeight: 1,
          signers: [{ publicKey: signer2.publicKey(), weight: 1 }],
          thresholds: { low: 1, medium: 3, high: 5 },
        }),
      ).rejects.toThrow(/Threshold too high/i);
    });

    it('test_add_signer', async () => {
      const master = Keypair.random();
      const newSigner = Keypair.random();
      mockAccountServer(toolkit, master.publicKey());

      const hash = await toolkit.addSigner(master.secret(), newSigner.publicKey(), 2);
      expect(hash).toBe('multisig_tx_hash_123');
    });

    it('test_remove_signer', async () => {
      const master = Keypair.random();
      const oldSigner = Keypair.random();
      mockAccountServer(toolkit, master.publicKey());

      const hash = await toolkit.removeSigner(master.secret(), oldSigner.publicKey());
      expect(hash).toBe('multisig_tx_hash_123');
    });

    it('test_max_signers', async () => {
      const master = Keypair.random();
      mockAccountServer(toolkit, master.publicKey());
      const signers = Array.from({ length: 20 }, () => ({
        publicKey: Keypair.random().publicKey(),
        weight: 1,
      }));

      const hash = await toolkit.configureMultiSig({
        masterSecret: master.secret(),
        masterWeight: 1,
        signers,
        thresholds: { low: 1, medium: 2, high: 3 },
      });
      expect(hash).toBe('multisig_tx_hash_123');

      const twentyOne = [...signers, { publicKey: Keypair.random().publicKey(), weight: 1 }];
      await expect(
        toolkit.configureMultiSig({
          masterSecret: master.secret(),
          signers: twentyOne,
          thresholds: { low: 1, medium: 2, high: 3 },
        }),
      ).rejects.toThrow(/Cannot exceed 20 signers/i);
    });

    it('test_weight_limits', async () => {
      const master = Keypair.random();
      const signer = Keypair.random();

      await expect(
        toolkit.configureMultiSig({
          masterSecret: master.secret(),
          signers: [{ publicKey: signer.publicKey(), weight: 256 }],
          thresholds: { low: 1, medium: 1, high: 1 },
        }),
      ).rejects.toThrow(/out of range/i);
    });

    it('covers getBalances, getNativeBalance, and custom signerWeights', async () => {
      const kp = Keypair.random();
      const server = (toolkit as unknown as { server: { loadAccount: jest.Mock } }).server;
      jest.spyOn(server, 'loadAccount').mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '123.4500000' }],
      } as unknown as never);

      const balances = await toolkit.getBalances(kp.publicKey());
      expect(balances).toHaveLength(1);
      const nativeBal = await toolkit.getNativeBalance(kp.publicKey());
      expect(nativeBal).toBe('123.4500000');

      toolkit.validateMultiSigConfig({
        masterSecret: kp.secret(),
        signers: [{ publicKey: kp.publicKey(), weight: 2 }],
        thresholds: { low: 1, medium: 2, high: 2 },
      });

      const s1 = Keypair.random();
      const dest = Keypair.random();
      const account = new Account(s1.publicKey(), '101');
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: dest.publicKey(),
            asset: Asset.native(),
            amount: '10',
          }),
        )
        .setTimeout(180)
        .build();

      const signed = toolkit.signMultiSigTransaction(tx, [s1.secret()], 3, {
        [s1.publicKey()]: 3,
      });
      expect(signed.signatures.length).toBe(1);
    });
  });
});
