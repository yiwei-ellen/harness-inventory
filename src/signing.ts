import { safeExec, pathExists } from "./util";
import { SigningStatus } from "./types";

export interface SigningInfo {
  signingStatus: SigningStatus;
  publisher?: string;
}

// Determine signing status for a resolved binary/bundle path by parsing the
// output of `codesign` and `spctl`. Runs for every Component with a real path,
// not only unidentified ones.
//
// Mapping:
//   - codesign reports it is not signed    -> unsigned
//   - codesign reports "not ... Mach-O"    -> unknown (not a signable object)
//   - codesign succeeds, spctl notarized   -> signed_notarized
//   - codesign succeeds, spctl not notar.  -> signed_unnotarized
//   - codesign succeeds, spctl unavailable -> signed_unnotarized (best-effort)
//
// Off-macOS (no codesign binary) everything resolves to unknown, so the tool
// never crashes on non-macOS hosts even though collection targets macOS.
export function inspectSigning(binPath: string): SigningInfo {
  if (!binPath || !pathExists(binPath)) {
    return { signingStatus: "unknown" };
  }

  const cs = safeExec("codesign", ["-dv", "--verbose=2", binPath]);
  // codesign writes its detail to stderr on success and failure alike.
  const csText = `${cs.stdout}\n${cs.stderr}`;

  if (!cs.ok) {
    if (/is not signed at all|code object is not signed/i.test(csText)) {
      return { signingStatus: "unsigned" };
    }
    if (
      /not recognized|is not a|does not exist|No such file|bundle format|not an? (?:Mach-O|bundle)/i.test(
        csText
      )
    ) {
      // Not a signable code object (e.g. a plain script). Signing does not
      // apply — report unknown rather than unsigned.
      return { signingStatus: "unknown" };
    }
    // codesign itself is missing (off-macOS) or some other failure.
    if (/ENOENT|command not found|spawn codesign/i.test(cs.stderr)) {
      return { signingStatus: "unknown" };
    }
    // Unclear failure: do not overclaim.
    return { signingStatus: "unknown" };
  }

  const publisher = parsePublisher(csText);

  // Signed; ask Gatekeeper whether it is notarized.
  const sp = safeExec("spctl", ["-a", "-vv", binPath]);
  const spText = `${sp.stdout}\n${sp.stderr}`;

  if (/source=Notarized|Notarized Developer ID/i.test(spText)) {
    return { signingStatus: "signed_notarized", publisher };
  }

  // Signed but not (or not verifiably) notarized.
  return { signingStatus: "signed_unnotarized", publisher };
}

// Extract a human-readable publisher from codesign output: prefer the leading
// Authority line (e.g. "Developer ID Application: Acme (TEAMID)"), else the
// TeamIdentifier.
function parsePublisher(text: string): string | undefined {
  const authority = text.match(/Authority=(.+)/);
  if (authority && authority[1].trim() && !/^\(unavailable\)/i.test(authority[1])) {
    return authority[1].trim();
  }
  const team = text.match(/TeamIdentifier=([A-Z0-9]+)/i);
  if (team && team[1] && team[1].toUpperCase() !== "NOT SET") {
    return `TeamID ${team[1]}`;
  }
  return undefined;
}
