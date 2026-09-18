import { Component, InstallMethod } from "../types";

// Build a Component with sensible defaults. Parsers only fill in what a source
// actually declares; identity/signing are refined in later stages.
export function makeComponent(
  partial: Partial<Component> & {
    name: string;
    installMethod: InstallMethod;
    path: string;
  }
): Component {
  return {
    platform: "macos",
    signingStatus: "unknown",
    firstSeen: "",
    sourceRefs: [],
    identified: false,
    ...partial,
  };
}
