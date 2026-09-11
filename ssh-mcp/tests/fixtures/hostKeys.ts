/**
 * Key material for the test fixtures (§6.2, Critic C12).
 *
 * Keys are generated at run time and never written to the repository. A
 * committed test key would trip secret scanners and would make the "zero PEM
 * headers in the tree" expectation of §8.6 untrue, for no benefit: ed25519
 * generation is instant.
 *
 * AC9 needs a *second* host key to play "the server's key changed", so this
 * module hands out independent pairs rather than a singleton.
 */
import { utils } from 'ssh2';

import { sha256Fingerprint } from '../../src/ssh/fingerprint.js';

export interface FixtureKeyPair {
  /** Private key in OpenSSH text format, generated fresh for this run. */
  privateKey: string;
  /** One-line OpenSSH public key, comment included. */
  publicKey: string;
  /** `SHA256:...` fingerprint of the public key blob. */
  fingerprint: string;
  algo: 'ssh-ed25519';
}

/**
 * A fresh ed25519 pair.
 *
 * `utils.generateKeyPairSync('ed25519', { comment })` is the documented API
 * (ssh2 README "Generate an SSH key"); the comment shows up in
 * `authorized_keys` and makes fixture keys recognisable in test output.
 */
export function generateKeyPair(comment = 'ssh-mcp-test'): FixtureKeyPair {
  const keys = utils.generateKeyPairSync('ed25519', { comment });
  const publicKey = keys.public.trim();
  return {
    privateKey: keys.private,
    publicKey,
    fingerprint: sha256Fingerprint(publicKeyBlob(publicKey)),
    algo: 'ssh-ed25519',
  };
}

/** Wire-format blob of a one-line OpenSSH public key. */
function publicKeyBlob(publicKey: string): Buffer {
  const encoded = publicKey.split(/\s+/)[1];
  if (encoded === undefined) throw new Error(`unexpected public key format: ${publicKey}`);
  return Buffer.from(encoded, 'base64');
}

/** Host key for a fixture server. */
export function generateHostKey(comment = 'ssh-mcp-fixture-host'): FixtureKeyPair {
  return generateKeyPair(comment);
}

/** Client key used to exercise public key authentication. */
export function generateClientKey(comment = 'ssh-mcp-fixture-client'): FixtureKeyPair {
  return generateKeyPair(comment);
}
