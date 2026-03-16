#!/usr/bin/env node

/**
 * Pre-install check: verifies that all required system prerequisites
 * are present before npm install runs. Fails fast with actionable messages.
 */

const { execSync } = require("child_process");

const errors = [];

// --- Node.js version ---
const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 18) {
  errors.push(
    `Node.js >= 18 is required (found v${process.versions.node}).\n` +
      `  Install it from https://nodejs.org or use nvm:\n` +
      `    nvm install 18 && nvm use 18`
  );
}

// --- npm version ---
try {
  const npmVersion = execSync("npm --version", { encoding: "utf8" }).trim();
  const [npmMajor] = npmVersion.split(".").map(Number);
  if (npmMajor < 9) {
    errors.push(
      `npm >= 9 is required for workspaces support (found v${npmVersion}).\n` +
        `  Update npm:\n` +
        `    npm install -g npm@latest`
    );
  }
} catch {
  errors.push(
    `npm is not available on PATH.\n` +
      `  Install Node.js from https://nodejs.org (npm is bundled with it).`
  );
}

// --- C++ toolchain (needed by better-sqlite3, tree-sitter) ---
function hasCommand(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

const hasMake = hasCommand("make");
const hasCxx =
  hasCommand("g++") || hasCommand("clang++") || hasCommand("c++");

if (!hasMake || !hasCxx) {
  const missing = [];
  if (!hasCxx) missing.push("C++ compiler (g++ or clang++)");
  if (!hasMake) missing.push("make");

  const platform = process.platform;
  let fix;
  if (platform === "linux") {
    fix =
      `  On Debian/Ubuntu:\n` +
      `    sudo apt-get install -y build-essential\n` +
      `  On Fedora/RHEL:\n` +
      `    sudo dnf groupinstall "Development Tools"`;
  } else if (platform === "darwin") {
    fix = `  Run:\n    xcode-select --install`;
  } else {
    fix =
      `  Install Visual Studio Build Tools:\n` +
      `    npm install -g windows-build-tools`;
  }

  errors.push(
    `C++ build toolchain is required by native dependencies (better-sqlite3, tree-sitter).\n` +
      `  Missing: ${missing.join(", ")}\n` +
      fix
  );
}

// --- Python (needed by node-gyp) ---
const hasPython =
  hasCommand("python3") || hasCommand("python");

if (!hasPython) {
  const platform = process.platform;
  let fix;
  if (platform === "linux") {
    fix = `    sudo apt-get install -y python3`;
  } else if (platform === "darwin") {
    fix = `    brew install python3`;
  } else {
    fix = `    https://www.python.org/downloads/`;
  }

  errors.push(
    `Python is required by node-gyp to build native modules.\n` +
      `  Install it:\n` +
      fix
  );
}

// --- Report ---
if (errors.length > 0) {
  console.error("\n\x1b[31m✘ Missing prerequisites:\x1b[0m\n");
  errors.forEach((err, i) => {
    console.error(`  ${i + 1}. ${err}\n`);
  });
  console.error(
    "\x1b[33mFix the above issues and re-run npm install.\x1b[0m\n"
  );
  process.exit(1);
}

console.log("\x1b[32m✔ All prerequisites met.\x1b[0m");
