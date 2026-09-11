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

/** Generated keys that fail to parse are discarded; see {@link generateKeyPair}. */
const MAX_GENERATION_ATTEMPTS = 12;

/**
 * A fresh ed25519 pair.
 *
 * `utils.generateKeyPairSync('ed25519', { comment })` is the documented API
 * (ssh2 README "Generate an SSH key"); the comment shows up in
 * `authorized_keys` and makes fixture keys recognisable in test output.
 *
 * The generated pair is parsed back before being handed out, because ssh2
 * 1.17.0 emits a malformed pair roughly once in every 130 calls: the encoded
 * body comes out three bytes short (four base64 characters less than a sound
 * key), and `parseKey`, `new Server({ hostKeys })` and the public key line all
 * reject it. Measured at 14 failures in 2000 generations, and the public half
 * is short too, so both are checked. Left unchecked it surfaces as an
 * unrelated-looking "Malformed OpenSSH private key" in whichever suite happened
 * to draw the bad key, so the flake is spent here rather than in every test
 * that needs a key.
 */
export function generateKeyPair(comment = 'ssh-mcp-test'): FixtureKeyPair {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const keys = utils.generateKeyPairSync('ed25519', { comment });
    const publicKey = keys.public.trim();
    if (utils.parseKey(keys.private) instanceof Error) continue;
    if (utils.parseKey(publicKey) instanceof Error) continue;

    return {
      privateKey: keys.private,
      publicKey,
      fingerprint: sha256Fingerprint(publicKeyBlob(publicKey)),
      algo: 'ssh-ed25519',
    };
  }
  throw new Error(
    `ssh2 produced ${String(MAX_GENERATION_ATTEMPTS)} unparseable ed25519 key pairs in a row`
  );
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
