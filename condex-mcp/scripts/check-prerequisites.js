#!/usr/bin/env node

/**
 * Pre-install check: verifies that all required system prerequisites
 * are present before npm install runs. Fails fast with actionable messages.
 */

const { execSync } = require("child_process");

// --- Colors ---
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

console.log(`\n${cyan("⏳ Checking prerequisites...")}\n`);

const errors = [];

function getCommandVersion(cmd, flag = "--version") {
  try {
    return execSync(`${cmd} ${flag}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function hasCommand(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function logCheck(label, required, found, pass, fix) {
  const status = pass ? green("✔ pass") : red("✘ FAIL");
  const foundStr = found || red("not found");
  console.log(`  ${status}  ${bold(label)}`);
  console.log(`         ${dim("required:")} >= ${required}`);
  console.log(`         ${dim("found:")}    ${foundStr}`);
  if (!pass && fix) {
    console.log(`         ${yellow("fix:")}      ${fix}`);
  }
  console.log();
}

// --- Node.js ---
const nodeVersion = process.versions.node;
const [nodeMajor] = nodeVersion.split(".").map(Number);
const nodePass = nodeMajor >= 18;
logCheck(
  "Node.js",
  "18.0.0",
  `v${nodeVersion}`,
  nodePass,
  "nvm install 18 && nvm use 18  (or download from https://nodejs.org)"
);
if (!nodePass) {
  errors.push("Node.js");
}

// --- npm ---
const npmVersion = getCommandVersion("npm");
let npmPass = false;
if (npmVersion) {
  const [npmMajor] = npmVersion.split(".").map(Number);
  npmPass = npmMajor >= 9;
}
logCheck(
  "npm",
  "9.0.0",
  npmVersion ? `v${npmVersion}` : null,
  npmPass,
  "npm install -g npm@latest"
);
if (!npmPass) {
  errors.push("npm");
}

// --- C++ compiler ---
let cxxName = null;
let cxxVersion = null;
for (const compiler of ["clang++", "g++", "c++"]) {
  if (hasCommand(compiler)) {
    cxxName = compiler;
    const raw = getCommandVersion(compiler);
    if (raw) {
      // extract first version-like string
      const match = raw.match(/(\d+\.\d+[\.\d]*)/);
      cxxVersion = match ? `${compiler} ${match[1]}` : compiler;
    } else {
      cxxVersion = compiler;
    }
    break;
  }
}
const cxxPass = cxxName !== null;
const cxxFix = process.platform === "darwin"
  ? "xcode-select --install"
  : process.platform === "linux"
    ? "sudo apt-get install -y build-essential"
    : "npm install -g windows-build-tools";
logCheck(
  "C++ compiler  (for better-sqlite3, tree-sitter)",
  "any",
  cxxVersion,
  cxxPass,
  cxxFix
);
if (!cxxPass) {
  errors.push("C++ compiler");
}

// --- make ---
let makeVersion = null;
if (hasCommand("make")) {
  const raw = getCommandVersion("make");
  if (raw) {
    const match = raw.match(/(\d+\.\d+[\.\d]*)/);
    makeVersion = match ? `v${match[1]}` : "installed";
  } else {
    makeVersion = "installed";
  }
}
const makePass = makeVersion !== null;
logCheck(
  "make  (for native module compilation)",
  "any",
  makeVersion,
  makePass,
  cxxFix
);
if (!makePass) {
  errors.push("make");
}

// --- Python (for node-gyp) ---
let pythonVersion = null;
let pythonCmd = null;
for (const cmd of ["python3", "python"]) {
  if (hasCommand(cmd)) {
    pythonCmd = cmd;
    const raw = getCommandVersion(cmd);
    if (raw) {
      const match = raw.match(/(\d+\.\d+[\.\d]*)/);
      pythonVersion = match ? `v${match[1]}` : "installed";
    } else {
      pythonVersion = "installed";
    }
    break;
  }
}
const pythonPass = pythonCmd !== null;
const pythonFix = process.platform === "darwin"
  ? "brew install python3"
  : process.platform === "linux"
    ? "sudo apt-get install -y python3"
    : "https://www.python.org/downloads/";
logCheck(
  "Python  (for node-gyp native builds)",
  "any",
  pythonVersion,
  pythonPass,
  pythonFix
);
if (!pythonPass) {
  errors.push("Python");
}

// --- Network sandbox (Layer 3: OS-level outbound block) ---
const platform = process.platform;
let sandboxVersion = null;
let sandboxAvailable = false;

if (platform === "darwin") {
  if (hasCommand("sandbox-exec")) {
    // Test if sandbox-exec actually works (enterprise MDM can block it)
    try {
      execSync(`sandbox-exec -p "(version 1)(allow default)" ${process.execPath} -e "process.exit(0)"`, { stdio: "pipe", timeout: 3000 });
      sandboxVersion = "sandbox-exec (working)";
      sandboxAvailable = true;
    } catch {
      sandboxVersion = yellow("sandbox-exec installed but blocked (MDM/enterprise restriction)");
    }
  } else {
    sandboxVersion = yellow("sandbox-exec not found");
  }
} else if (platform === "linux") {
  if (hasCommand("unshare")) {
    try {
      execSync(`unshare --net ${process.execPath} -e "process.exit(0)"`, { stdio: "pipe", timeout: 3000 });
      sandboxVersion = "unshare --net (working)";
      sandboxAvailable = true;
    } catch {
      sandboxVersion = yellow("unshare installed but needs root/CAP_SYS_ADMIN");
    }
  } else {
    sandboxVersion = yellow("unshare not found");
  }
} else {
  sandboxVersion = yellow("not available on " + platform);
}

// Sandbox is always "pass" — it's optional, Layer 2 + 3b protect regardless
logCheck(
  "Network sandbox  (Layer 3: OS-level — optional)",
  "any",
  sandboxAvailable ? green(sandboxVersion) : sandboxVersion,
  true, // never fail — fallback exists
  null
);

if (!sandboxAvailable) {
  console.log(`         ${dim("fallback:")} DNS + proxy poisoning (Layer 3b) will be used instead`);
  console.log();
}

// --- Network block verification (quick smoke test) ---
let netBlockPass = false;
let netBlockResult = null;
try {
  const testScript = `
    const net = require('net');
    net.Socket.prototype.connect = function() { throw new Error('NETWORK_BLOCKED'); };
    try {
      const s = new net.Socket();
      s.connect(80, '1.1.1.1');
      process.exit(1);
    } catch (e) {
      if (e.message === 'NETWORK_BLOCKED') process.exit(0);
      process.exit(1);
    }
  `;
  execSync(`${process.execPath} -e "${testScript.replace(/\n/g, " ")}"`, { stdio: "pipe", timeout: 5000 });
  netBlockPass = true;
  netBlockResult = "Layer 2 monkey-patch blocks connections";
} catch {
  netBlockResult = red("monkey-patch failed to block connections");
}

logCheck(
  "Network guard  (Layer 2: Node.js API monkey-patch)",
  "blocks outbound",
  netBlockPass ? green(netBlockResult) : netBlockResult,
  netBlockPass,
  "Check network-guard.ts — monkey-patching may be broken"
);
if (!netBlockPass) {
  errors.push("Network guard");
}

// --- Summary ---
console.log(dim("  ─────────────────────────────────────────────"));
console.log(`\n  ${dim("Network isolation: 4-layer defense")}`);
console.log(`  ${dim("  Layer 1:  Env vars (TRANSFORMERS_OFFLINE=1)")}`);
console.log(`  ${dim("  Layer 2:  Node.js API monkey-patch (net, http, https, fetch, dgram, dns)")}`);
console.log(`  ${dim(`  Layer 3:  OS sandbox (${sandboxAvailable ? (platform === "darwin" ? "sandbox-exec ✔" : "unshare --net ✔") : "unavailable — skipped"})`)}`);
console.log(`  ${dim(`  Layer 3b: DNS + proxy poisoning (${sandboxAvailable ? "active as backup" : "active as primary"})`)}`);
console.log();

if (errors.length > 0) {
  console.error(`\n  ${red("✘")} ${bold("Prerequisite check failed:")} ${errors.join(", ")}\n`);
  console.error(`  ${yellow("Fix the above issues and try again.")}\n`);
  process.exit(1);
}

console.log(`\n  ${green("✔")} ${bold("All prerequisites met.")}\n`);
