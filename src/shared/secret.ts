#!/usr/bin/env node
/**
 * Keep secrets in the macOS Keychain instead of plain text in .env:
 *   npm run secret -- set NAME        prompt (hidden) for the value, store it, write NAME=keychain:NAME
 *   npm run secret -- migrate         move every secret-looking value (TOKEN/SECRET/KEY/PASSWORD) from the env file
 *   npm run secret -- list            show which variables use the Keychain (values never printed)
 *   npm run secret -- delete NAME     remove it from the Keychain (the env line is left empty)
 * Honors MCP_PROFILE (agency mode): the active file is .env.<profile>.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { KEYCHAIN_SERVICE, profile, profileEnv } from "./env.js";

if (process.platform !== "darwin") {
  console.error("The Keychain helper is macOS-only. On other systems use 1Password references (NAME=op://vault/item/field) or keep values in .env.");
  process.exit(1);
}

const SECRET = /(TOKEN|SECRET|KEY|PASSWORD|PASS)$/;
const account = (name: string) => (profile ? `${profile}/${name}` : name);

function readLines(): string[] {
  return existsSync(profileEnv) ? readFileSync(profileEnv, "utf8").split("\n") : [];
}
function writeLine(name: string, value: string) {
  const lines = readLines();
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(profileEnv, lines.join("\n"), { mode: 0o600 });
}
function store(name: string, value: string) {
  execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account(name), "-w", value], { stdio: "ignore" });
  writeLine(name, `keychain:${account(name)}`);
}

async function hidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  out._writeToOutput = (s: string) => {
    if (s.startsWith(prompt)) out.output.write(prompt);
  };
  const answer = await new Promise<string>((r) => rl.question(prompt, r));
  rl.close();
  process.stdout.write("\n");
  return answer.trim();
}

const [cmd, name] = process.argv.slice(2);
switch (cmd) {
  case "set": {
    if (!name || !/^[A-Z0-9_]+$/.test(name)) throw new Error("Usage: npm run secret -- set NAME");
    const value = await hidden(`Value for ${name}: `);
    if (!value) throw new Error("Empty value — nothing stored");
    store(name, value);
    console.log(`Stored ${name} in the Keychain (service ${KEYCHAIN_SERVICE}); ${profileEnv} now references it.`);
    break;
  }
  case "migrate": {
    let moved = 0;
    for (const line of readLines()) {
      const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
      if (!m || !SECRET.test(m[1]) || m[2].startsWith("keychain:") || m[2].startsWith("op://")) continue;
      store(m[1], m[2].trim());
      moved++;
    }
    console.log(`Moved ${moved} secret(s) from ${profileEnv} into the Keychain.`);
    break;
  }
  case "list": {
    const rows = readLines().filter((l) => /^[A-Z0-9_]+=(keychain:|op:\/\/)/.test(l)).map((l) => l.split("=")[0]);
    console.log(rows.length ? rows.join("\n") : "No variables use the Keychain or 1Password yet.");
    break;
  }
  case "delete": {
    if (!name) throw new Error("Usage: npm run secret -- delete NAME");
    try {
      execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(name)], { stdio: "ignore" });
    } catch {
      /* not there */
    }
    writeLine(name, "");
    console.log(`Removed ${name} from the Keychain.`);
    break;
  }
  default:
    console.log("Usage: npm run secret -- set NAME | migrate | list | delete NAME");
}
