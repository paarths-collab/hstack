#!/usr/bin/env node
// hstack-acceptance CLI. Three commands and nothing else:
//   validate-receipt <receipt.json>
//   plan-hash <blueprint.json> [contract.json] --chat-id <id> --schedule '<cron>'
//   review    <blueprint.json> [contract.json] --host <h> --user <u> --chat-id <id> --schedule '<cron>'
// None of them touches the network. `review` prints the exact, reviewable op list.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_CONTRACT_PATH, loadContract } from "./contract.js";
import { readTargetScript } from "./artifacts.js";
import { validateReceiptText } from "./receipt.js";
import { SshTransport } from "./transports.js";
import { DEFAULT_SCRIPT_PATH, buildReview, validateBlueprintStructure } from "./transaction.js";
import { deriveExecutionGraph, planHash, renderUntrustedText } from "./untrusted.js";

const USAGE = `usage:
  hstack-acceptance validate-receipt <receipt.json>
  hstack-acceptance plan-hash <blueprint.json> [contract.json] --chat-id <id> --schedule '<cron>'
  hstack-acceptance review <blueprint.json> [contract.json] --host <host> --user <user> --chat-id <id> --schedule '<cron>'`;

function parseArgs(argv, valueFlags) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      if (!valueFlags.includes(arg) || index + 1 >= argv.length) throw new Error(`unknown or incomplete option ${arg.slice(0, 40)}`);
      flags[arg.slice(2)] = argv[(index += 1)];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function shellDisplay(text) {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export async function main(argv, io = { out: (text) => process.stdout.write(`${text}\n`), err: (text) => process.stderr.write(`${text}\n`) }) {
  const [command, ...rest] = argv;
  try {
    if (command === "validate-receipt") {
      const { positional } = parseArgs(rest, []);
      if (positional.length !== 1) throw new Error("validate-receipt takes exactly one file");
      const result = validateReceiptText(readFileSync(positional[0], "utf8"));
      if (!result.valid) {
        io.err("INVALID RECEIPT");
        for (const error of result.errors) io.err(`  - ${error}`);
        return 1;
      }
      const { receipt } = result;
      io.out(`VALID receipt: state=${receipt.state} txn=${receipt.txn_id}`);
      io.out(`transport_used: ${receipt.target_profile.transport_used}`);
      if (receipt.target_profile.transport_used !== "ssh") {
        io.out("WARNING: SIMULATED target \u2014 not evidence about a real server");
      }
      if (receipt.target_profile.adapter_surface === "declared-unverified-against-real-hermes") {
        io.out("WARNING: the Hermes adapter surface is declared-unverified against real Hermes");
      }
      io.out("note: receipts are unsigned and not tamper-evident; treat them as sensitive");
      return 0;
    }

    if (command === "plan-hash" || command === "review") {
      const valueFlags = command === "review" ? ["--host", "--user", "--chat-id", "--schedule"] : ["--chat-id", "--schedule"];
      const { positional, flags } = parseArgs(rest, valueFlags);
      if (positional.length < 1 || positional.length > 2) throw new Error(`${command} takes <blueprint.json> [contract.json]`);
      if (!flags["chat-id"] || !flags.schedule) throw new Error("--chat-id and --schedule are required (operator input, never read from the blueprint)");
      const blueprint = readJson(positional[0]);
      const contract = loadContract(positional[1] ? path.resolve(positional[1]) : DEFAULT_CONTRACT_PATH);
      const operator = { chatId: flags["chat-id"], schedule: flags.schedule };

      if (command === "plan-hash") {
        io.out(planHash(deriveExecutionGraph(blueprint, contract, operator)));
        return 0;
      }

      if (!flags.host || !flags.user) throw new Error("review requires --host and --user");
      const ssh = new SshTransport({ host: flags.host, user: flags.user }); // validates host/user; never connects
      const structural = validateBlueprintStructure(blueprint);
      if (!structural.valid) {
        io.err("INVALID BLUEPRINT (invalid_blueprint)");
        for (const error of structural.errors) io.err(`  ${renderUntrustedText(error)}`);
        return 1;
      }
      const scriptBody = existsSync(DEFAULT_SCRIPT_PATH) ? readTargetScript(DEFAULT_SCRIPT_PATH) : null;
      const review = buildReview({ blueprint, contract, operator, txnId: "00000000", scriptBody });
      io.out(`recipe: ${review.recipe}`);
      io.out(`plan_hash: ${review.plan_hash}`);
      io.out(`contract_hash: ${review.contract_hash}`);
      io.out(`destination_fingerprint: ${review.destination_fingerprint}`);
      io.out(`recovery_point: ${review.recovery_point} (transaction id shown here is illustrative)`);
      io.out(`schedule: ${review.schedule.cron}  prompt (from contract): ${review.schedule.prompt}`);
      io.out(`name:        ${review.display.name}`);
      io.out(`description: ${review.display.description}`);
      io.out("ops (in order):");
      review.ops.forEach((op, index) => {
        io.out(`${String(index + 1).padStart(2, "0")}. ${op.op_id}  [${op.phase}/${op.mutates}]  expected previous: ${op.expected_previous}`);
        io.out(`    $ ssh ${ssh.argvFor(op).map((part, i) => (i === 3 ? shellDisplay(part) : part)).join(" ")}`);
        io.out(`    < ${op.stdin ?? "(no stdin)"}`);
      });
      for (const note of review.notes) io.out(`note: ${note}`);
      return 0;
    }

    io.err(USAGE);
    return 2;
  } catch (error) {
    io.err(`error: ${error.message}`);
    return 2;
  }
}

/**
 * True when this module is the process entry point. Node resolves symlinks for import.meta.url but leaves
 * process.argv[1] as typed, so compare real paths: the npm bin shim and macOS /tmp are symlinks.
 */
export function isEntryPoint(moduleUrl = import.meta.url, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(path.resolve(entry));
  } catch {
    return moduleUrl === pathToFileURL(entry).href;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
