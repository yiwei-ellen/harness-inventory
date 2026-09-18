import * as https from "https";
import * as fs from "fs";
import { REPO_SLUG } from "./shadowReport";

// The ONE permitted background network call: fetch the latest known-agents.json
// from this project's own repo. Off by default (--update-catalog). Single GET to
// a pinned URL, logged to the user before it happens.
const CATALOG_RAW_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/catalog/known-agents.json`;

export function catalogUpdateUrl(): string {
  return CATALOG_RAW_URL;
}

// Fetch and overwrite the local catalog file. Announces the URL first. Returns
// true on success. Any failure is reported and non-fatal (the scan proceeds
// with the existing local catalog).
export async function updateCatalog(localPath: string): Promise<boolean> {
  console.log(`[network] Fetching latest catalog from: ${CATALOG_RAW_URL}`);
  try {
    const body = await httpGet(CATALOG_RAW_URL);
    // Validate it parses before overwriting, so a bad response can't corrupt the
    // shipped catalog.
    JSON.parse(body);
    fs.writeFileSync(localPath, body, "utf8");
    console.log(`[network] Catalog updated at ${localPath}`);
    return true;
  } catch (err: any) {
    console.error(
      `[network] Catalog update failed (${
        err?.message ?? err
      }). Continuing with the existing catalog.`
    );
    return false;
  }
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        // Follow a single redirect (raw.githubusercontent may 30x).
        res.resume();
        httpGet(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
  });
}
