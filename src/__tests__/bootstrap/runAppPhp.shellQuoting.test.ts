import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { shellSingleQuote } from '../../scenarios/bootstrap/uatPrivileged.js';

/**
 * The exact snippet `seedBtCredentialForOrg` sends. It is reproduced verbatim rather than
 * imported because what is under test is how a PHP `$variable` survives a shell, and a
 * simplified stand-in without a `$` would pass under the defect.
 */
const REAL_SNIPPET =
  'require "/var/www/html/vendor/autoload.php";' +
  '$a = require "/var/www/html/bootstrap/app.php";' +
  '$a->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();' +
  'echo Illuminate\\Support\\Facades\\Crypt::encryptString("test_iPay3_ap!e4r");';

/**
 * What ssh does to the far side: it concatenates its command arguments and hands the result
 * to a login shell, which re-parses it. `sh -c` is that re-parse, so running the built word
 * through `echo` reproduces the round trip without needing ssh, docker or a server.
 */
function throughRemoteShell(builtWord: string): string {
  return execFileSync('sh', ['-c', `echo ${builtWord}`], { encoding: 'utf-8' }).replace(/\n$/, '');
}

describe('runAppPhp remote quoting', () => {
  it('carries a PHP snippet through a remote shell unchanged, $variables included', () => {
    expect(throughRemoteShell(shellSingleQuote(REAL_SNIPPET))).toBe(REAL_SNIPPET);
  });

  /**
   * THE OTHER ARM, and the reason this file exists. Without it the test above passes under
   * any quoting that happens not to corrupt THIS string, and the defect it guards is
   * invisible. `JSON.stringify` was what shipped: a DOUBLE-quoted word, inside which a POSIX
   * shell still expands `$name`. The bootstrap died on it after provisioning five stations,
   * and the error named php ("unexpected token \"=\"") rather than the shell that had
   * already deleted `$a`.
   */
  it('pins the defect: JSON.stringify loses $a to the far-side shell', () => {
    const asShipped = throughRemoteShell(JSON.stringify(REAL_SNIPPET));

    expect(asShipped).not.toBe(REAL_SNIPPET);
    expect(asShipped).not.toContain('$a');
    // What php actually received: an assignment with nothing on its left-hand side.
    expect(asShipped).toContain(' = require "/var/www/html/bootstrap/app.php";');
  });

  it('carries a literal single quote, which the close/escape/reopen form is for', () => {
    const withQuote = `echo 'it\\'s';`;
    expect(throughRemoteShell(shellSingleQuote(withQuote))).toBe(withQuote);
  });
});
