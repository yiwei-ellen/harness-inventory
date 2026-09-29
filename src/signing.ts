import { safeExec, pathExists } from "./util";
import { SigningStatus } from "./types";

export interface SigningInfo {
  signingStatus: SigningStatus;
  publisher?: string;
  // Apple Developer team identifier, when the signature carries one. Ad-hoc
  // and Apple platform binaries report "not set" and get none.
  teamId?: string;
}

// Determine signing status for a resolved binary/bundle path by parsing the
// output of `codesign` and `spctl`. Runs for every Component with a real path,
// not only unidentified ones.
//
// Mapping:
//   - codesign reports it is not signed    -> unsigned
//   - codesign succeeds, spctl notarized   -> signed_notarized
//   - codesign succeeds, spctl not notar.  -> signed_unnotarized
//   - anything else (not a signable object, codesign missing off-macOS, or an
//     unclear failure) -> unknown, so we never overclaim or crash off-macOS.
export function inspectSigning(binPath: string): SigningInfo {
  if (!binPath || !pathExists(binPath)) {
    return { signingStatus: "unknown" };
  }

  const cs = safeExec("codesign", ["-dv", "--verbose=2", binPath]);
  // codesign writes its detail to stderr on success and failure alike.
  const csText = `${cs.stdout}\n${cs.stderr}`;

  if (!cs.ok) {
    // The only failure we can classify confidently is an unsigned code object;
    // every other failure is "not determinable" -> unknown.
    if (/is not signed at all|code object is not signed/i.test(csText)) {
      return { signingStatus: "unsigned" };
    }
    return { signingStatus: "unknown" };
  }

  const publisher = parsePublisher(csText);
  const teamId = parseTeamId(csText);

  // Signed; ask Gatekeeper whether it is notarized.
  const sp = safeExec("spctl", ["-a", "-vv", binPath]);
  const spText = `${sp.stdout}\n${sp.stderr}`;

  if (/source=Notarized|Notarized Developer ID/i.test(spText)) {
    return { signingStatus: "signed_notarized", publisher, teamId };
  }

  // Signed but not (or not verifiably) notarized.
  return { signingStatus: "signed_unnotarized", publisher, teamId };
}

// TeamIdentifier from codesign output. Apple team IDs are 10 uppercase
// alphanumerics; anything else ("not set") is treated as absent.
export function parseTeamId(text: string): string | undefined {
  const team = text.match(/TeamIdentifier=([A-Za-z0-9]+)/);
  if (team && /^[A-Z0-9]{10}$/.test(team[1])) return team[1];
  return undefined;
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
