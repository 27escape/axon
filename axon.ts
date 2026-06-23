#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run --allow-write
// axon
/**
 * Axon: Multi-Node Parallel SSH Executor & Live Grid TUI Dashboard
 * Features tag-based routing, strict SSH key auth, unattended execution, dry-run safety, local command execution, global timeouts, persistent XDG logging, and dynamic layout resizing.
 */

const VERSION = "4.0.1";

import { colors, Command, parseYaml } from "./deps.ts";

interface CommandConfig {
  name: string;
  aliases?: string[];
  check_command?: string;
  command: string;
  post_command?: string;
  tags: string[];
  type?: "remote" | "local";
}

interface ServerConfig {
  name: string;
  ip: string;
  user: string;
  active: boolean;
  tags: string[];
}

interface YamlConfig {
  commands: CommandConfig[];
  servers: ServerConfig[];
}

interface ServerStatus {
  config: ServerConfig;
  status: "Success" | "Failed" | "Skipped" | "Offline" | "Aborted" | "Timeout";
  currentPhase: "Queued" | "Pinging" | "Checking SSH" | "Checking State" | "Running" | "Success" | "Failed" | "Aborted" | "Timeout";
  outputBuffer: string[];
}

// --- Global Application State for Graceful Shutdown & Concurrency ---
const APP_STATE = {
  isShuttingDown: false,
  isCompleted: false,
  uiInterval: undefined as ReturnType<typeof setInterval> | undefined,
  servers: [] as ServerStatus[],
  abortController: new AbortController()
};

const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 Minutes Watchdog

// --- Directory Setup & Persistence ---
const USER = Deno.env.get("USER") || "default";
const HOME = Deno.env.get("HOME") || "/root";
const STATE_DIR = `${HOME}/.local/state/axon`;
const LOG_DIR = `${STATE_DIR}/logs`;
const DOWNLOADS_DIR = `${STATE_DIR}/downloads`;
const AXON_LOG = "axon.log";

function initDirectories() {
  try {
    Deno.mkdirSync(LOG_DIR, { recursive: true });
    Deno.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  } catch (_e) {
    // Failsafe: If XDG path fails (e.g. permission issues), fallback to temp.
  }
}

async function pruneOldLogs() {
  try {
    const files = [];
    for await (const dirEntry of Deno.readDir(LOG_DIR)) {
      if (dirEntry.isFile && dirEntry.name.startsWith("run_") && dirEntry.name.endsWith(".json")) {
        const stat = await Deno.stat(`${LOG_DIR}/${dirEntry.name}`);
        files.push({ name: dirEntry.name, time: stat.mtime?.getTime() || 0 });
      }
    }
    // Sort newest first, keep top 10
    files.sort((a, b) => b.time - a.time);
    const toDelete = files.slice(10);
    for (const file of toDelete) {
      await Deno.remove(`${LOG_DIR}/${file.name}`).catch(() => {});
    }
  } catch (_e) {
    // Silently ignore pruning errors to protect the main run loop
  }
}

function validateYamlConfig(data: unknown, source: string): asserts data is YamlConfig {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fatal(`Error: Invalid YAML structure in ${source}. Expected an object with 'commands' and 'servers'.`);
  }
  const root = data as Record<string, unknown>;
  if (!Array.isArray(root.commands)) fatal(`Error: Invalid configuration in ${source}: 'commands' must be a list.`);
  if (!Array.isArray(root.servers)) fatal(`Error: Invalid configuration in ${source}: 'servers' must be a list.`);
  
  root.commands.forEach((command, index) => {
    const cmd = command as Record<string, unknown>;
    if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) fatal(`Error: Command entry at index ${index} is malformed.`);
    if (typeof cmd.name !== "string" || cmd.name.trim() === "") fatal(`Error: Command entry at index ${index} must have a non-empty 'name'.`);
    if (typeof cmd.command !== "string" || cmd.command.trim() === "") fatal(`Error: Command '${cmd.name}' must have a non-empty 'command'.`);
    if (cmd.check_command !== undefined && typeof cmd.check_command !== "string") fatal(`Error: Command '${cmd.name}' has invalid 'check_command'.`);
    if (cmd.post_command !== undefined && typeof cmd.post_command !== "string") fatal(`Error: Command '${cmd.name}' has invalid 'post_command'.`);
    if (!Array.isArray(cmd.tags) || cmd.tags.some((tag) => typeof tag !== "string")) fatal(`Error: Command '${cmd.name}' must have a 'tags' array.`);
    if (cmd.type !== undefined && cmd.type !== "local" && cmd.type !== "remote") fatal(`Error: Command '${cmd.name}' type must be 'local' or 'remote'.`);
  });

  root.servers.forEach((server, index) => {
    const srv = server as Record<string, unknown>;
    if (!srv || typeof srv !== "object" || Array.isArray(srv)) fatal(`Error: Server entry at index ${index} is malformed.`);
    if (typeof srv.name !== "string" || srv.name.trim() === "") fatal(`Error: Server entry at index ${index} must have a 'name'.`);
    if (typeof srv.ip !== "string" || srv.ip.trim() === "") fatal(`Error: Server '${srv.name}' must have an 'ip'.`);
    if (typeof srv.user !== "string" || srv.user.trim() === "") fatal(`Error: Server '${srv.name}' must have a 'user'.`);
    if (typeof srv.active !== "boolean") fatal(`Error: Server '${srv.name}' must have an 'active' boolean flag.`);
    if (!Array.isArray(srv.tags) || srv.tags.some((tag) => typeof tag !== "string")) fatal(`Error: Server '${srv.name}' must have a 'tags' array.`);
  });
}

function listAvailableCommands(parsedData: YamlConfig, options: { server?: string; tag?: string; }): void {
  const byServer = options.server !== undefined;
  const byTag = options.tag !== undefined;

  let validServer: ServerConfig | undefined;
  let filteredCommands: CommandConfig[] = parsedData.commands;

  if (byServer) {
    validServer = parsedData.servers.find((s) => s.name === options.server);
    if (!validServer) fatal(`Error: Server '${options.server}' not found in configuration.`);
    filteredCommands = parsedData.commands.filter((cmd) => cmd.tags.some((tag) => validServer!.tags.includes(tag)));
  }

  if (byTag) {
    filteredCommands = parsedData.commands.filter((cmd) =>
      cmd.tags.includes(options.tag!) && (!byServer || cmd.tags.some((tag) => validServer!.tags.includes(tag)))
    );
  }

  const title = byServer ? `Valid commands for server '${validServer!.name}'` : byTag ? `Valid commands for tag '${options.tag}'` : "Available commands";
  console.log(colors.bold.cyan(`\n=== ${title} ===\n`));

  if (filteredCommands.length === 0) {
    console.log(colors.yellow("No commands match the requested criteria."));
    Deno.exit(0);
  }

  filteredCommands.forEach((cmd) => {
    const aliasText = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(", ")})` : "";
    const typeText = cmd.type === "local" ? colors.magenta(" [LOCAL]") : "";
    console.log(colors.bold(cmd.name) + aliasText + typeText);
    if (cmd.check_command) console.log(colors.gray(`  Idempotency Check: ${cmd.check_command}`));
    console.log(`  Tags: ${cmd.tags.join(", ")}\n`);
  });
}

function listAvailableServers(parsedData: YamlConfig, options: { server?: string; tag?: string; }): void {
  let filteredServers: ServerConfig[] = parsedData.servers;
  if (options.server) filteredServers = filteredServers.filter(s => s.name === options.server);
  if (options.tag) filteredServers = filteredServers.filter((server) => server.tags.includes(options.tag!));

  console.log(colors.bold.cyan(`\n=== Available Servers ===\n`));
  filteredServers.forEach((server) => {
    console.log(colors.bold(server.name));
    console.log(`  IP: ${server.ip} | User: ${server.user} | Active: ${server.active ? "yes" : "no"} | Tags: ${server.tags.join(", ")}\n`);
  });
}

let TARGET_COMMAND = "";
let TARGET_CHECK_COMMAND: string | undefined = undefined;
let TARGET_POST_COMMAND: string | undefined = undefined;
let TARGET_COMMAND_NAME = "";
let TARGET_COMMAND_TYPE: "remote" | "local" = "remote";
let IS_UNATTENDED = false;
let IS_VERBOSE = false;
let IS_DRY_RUN = false;
let IS_FORCED = false;

function fatal(message: string): never {
  console.error(colors.red(message));
  Deno.exit(1);
}

async function logToFile(serverName: string, message: string): Promise<void> {
  const logPath = `${LOG_DIR}/${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`;
  try { await Deno.writeTextFile(logPath, `[${new Date().toISOString()}] ${message}\n`, { append: true }); } catch (_e) {}
}

function renderTemplate(template: string, server: ServerConfig, status?: string): string {
  return template
    .replace(/\{\{home\}\}/g, HOME)
    .replace(/\{\{ip\}\}/g, server.ip)
    .replace(/\{\{user\}\}/g, server.user)
    .replace(/\{\{server_name\}\}/g, server.name)
    .replace(/\{\{downloads\}\}/g, DOWNLOADS_DIR)
    .replace(/\{\{name\}\}/g, TARGET_COMMAND_NAME)
    .replace(/\{\{status\}\}/g, status ?? "");
}

const LAYOUT = {
  cols: 2, boxWidth: 55, boxHeight: 10, logRows: 6,
  startX: (col: number) => col * (LAYOUT.boxWidth - 1) + 1,
  startY: (row: number) => 1 + row * (LAYOUT.boxHeight - 1),
};

function calculateLayout(serverCount: number): void {
  try {
    const { columns, rows } = Deno.consoleSize();
    if (serverCount === 1) {
      LAYOUT.cols = 1;
      LAYOUT.boxWidth = columns;
      LAYOUT.boxHeight = rows;
      LAYOUT.logRows = rows - 4;
    } else {
      LAYOUT.cols = Math.ceil(Math.sqrt(serverCount));
      const gridRows = Math.ceil(serverCount / LAYOUT.cols);
      LAYOUT.boxWidth = Math.max(40, Math.floor((columns - 2 + (LAYOUT.cols - 1)) / LAYOUT.cols));
      LAYOUT.boxHeight = Math.max(7, Math.floor((rows + (gridRows - 1)) / gridRows));
      LAYOUT.logRows = Math.max(0, LAYOUT.boxHeight - 4);
    }
  } catch (_e) {}
}

const Terminal = {
  encoder: new TextEncoder(),
  write: (text: string) => Deno.stdout.writeSync(Terminal.encoder.encode(text)),
  enterAltScreen: () => Terminal.write("\x1b[?1049h"),
  leaveAltScreen: () => Terminal.write("\x1b[?1049l"),
  hideCursor: () => Terminal.write("\x1b[?25l"),
  showCursor: () => Terminal.write("\x1b[?25h"),
  clearScreen: () => Terminal.write("\x1b[2J"),
  moveTo: (x: number, y: number) => Terminal.write(`\x1b[${y};${x}H`),
};

async function pingHost(server: ServerConfig): Promise<boolean> {
  const isMac = Deno.build.os === "darwin";
  try {
    const command = new Deno.Command("ping", { 
      args: ["-c", "1", "-W", isMac ? "2000" : "2", server.ip], 
      stdout: "null", 
      stderr: "null",
      signal: APP_STATE.abortController.signal 
    });
    const { success } = await command.output();
    return success;
  } catch (_e) { return true; }
}

function drawStaticLayout(servers: ServerStatus[]): void {
  Terminal.clearScreen();
  Terminal.hideCursor();
  const cols = LAYOUT.cols;
  const rows = Math.ceil(servers.length / cols);
  const innerW = LAYOUT.boxWidth - 2;

  let titleLine = IS_DRY_RUN ? colors.bgYellow.black(`  *** DRY RUN MODE ACTIVE *** `) : "";
  if (IS_FORCED) titleLine += colors.bgRed.white(`  *** FORCE MODE ACTIVE *** `);
  
  if (titleLine) {
    Terminal.moveTo(1, 1);
    Terminal.write(titleLine);
  }

  const yOffset = (IS_DRY_RUN || IS_FORCED) ? 1 : 0;

  for (let r = 0; r < rows; r++) {
    const topY = LAYOUT.startY(r) + yOffset;
    let topLine = "";
    for (let c = 0; c < cols; c++) topLine += (c === 0 ? "╔" : "╦") + "═".repeat(innerW);
    Terminal.moveTo(1, topY); Terminal.write(topLine + "╗");

    for (let h = 1; h < LAYOUT.boxHeight - 1; h++) {
      let midLine = "";
      for (let c = 0; c < cols; c++) midLine += "║" + " ".repeat(innerW);
      Terminal.moveTo(1, topY + h); Terminal.write(midLine + "║");
    }

    let bottomLine = "";
    for (let c = 0; c < cols; c++) bottomLine += (c === 0 ? "╚" : "╩") + "═".repeat(innerW);
    Terminal.moveTo(1, topY + LAYOUT.boxHeight - 1); Terminal.write(bottomLine + "╝");
  }
}

function updateGridCell(server: ServerStatus, index: number): void {
  const col = index % LAYOUT.cols, row = Math.floor(index / LAYOUT.cols);
  const yOffset = (IS_DRY_RUN || IS_FORCED) ? 1 : 0;
  const startX = LAYOUT.startX(col) + 1, startY = LAYOUT.startY(row) + 1 + yOffset;
  const innerW = LAYOUT.boxWidth - 2;

  const colorMap = { 
    "Success": colors.green, 
    "Failed": colors.red, 
    "Skipped": colors.gray, 
    "Offline": colors.red, 
    "Aborted": colors.magenta,
    "Timeout": colors.red 
  };
  const phaseText = server.status in colorMap && server.status !== "Success" ? server.status : server.currentPhase;
  const statusColor = colorMap[server.status as keyof typeof colorMap] || colors.yellow;
  
  let header = `${colors.bold(server.config.name)} (${server.config.ip}) ${statusColor(phaseText)}`;
  if (header.length > innerW) header = header.substring(0, innerW - 3) + "...";
  
  Terminal.moveTo(startX, startY); Terminal.write(header.padEnd(innerW));
  Terminal.moveTo(startX, startY + 1); Terminal.write("─".repeat(innerW));

  const logsToDisplay = [...server.outputBuffer.slice(-LAYOUT.logRows), ...Array(LAYOUT.logRows).fill("")].slice(0, LAYOUT.logRows);
  logsToDisplay.forEach((line, i) => {
    let clean = line.replace(/\t/g, "    ").trim();
    if (clean.length > innerW) clean = clean.substring(0, innerW - 3) + "...";
    Terminal.moveTo(startX, startY + 2 + i); Terminal.write(colors.gray(clean.padEnd(innerW)));
  });
}

function drawCompletionMessage(): void {
  if (IS_UNATTENDED || APP_STATE.servers.length === 0) return;
  const yOffset = (IS_DRY_RUN || IS_FORCED) ? 1 : 0;
  const totalRows = Math.ceil(APP_STATE.servers.length / LAYOUT.cols);
  // Calculate the exact line below the bottom of the grid
  const bottomY = LAYOUT.startY(totalRows - 1) + LAYOUT.boxHeight + yOffset + 1;
  Terminal.moveTo(1, bottomY);
  // The padding clears any stray characters that might have been there
  Terminal.write(colors.bold.cyan("Completed - Press any key to exit...") + " ".repeat(10));
}

// --- Dynamic Window Resizing Logic ---
function handleResize(): void {
  if (APP_STATE.isShuttingDown || IS_UNATTENDED || APP_STATE.servers.length === 0) return;
  calculateLayout(APP_STATE.servers.length);
  Terminal.clearScreen();
  drawStaticLayout(APP_STATE.servers);
  APP_STATE.servers.forEach((s, i) => updateGridCell(s, i));
  
  // Restore the completion prompt if we are in the waiting phase
  if (APP_STATE.isCompleted) {
    drawCompletionMessage();
  }
}

try {
  Deno.addSignalListener("SIGWINCH", handleResize);
} catch (_e) {
  // Gracefully ignore on operating systems that do not support SIGWINCH (e.g., Windows)
}

// --- Unified Shutdown Handler ---
async function gracefulShutdown(reason: string): Promise<never> {
  if (APP_STATE.isShuttingDown) await new Promise(() => {}); // Prevent recursive shutdown loops
  APP_STATE.isShuttingDown = true;

  // Immediately terminate any hanging processes
  APP_STATE.abortController.abort();

  if (APP_STATE.uiInterval) clearInterval(APP_STATE.uiInterval);

  // If interrupted or timed out, mark any non-terminal states explicitly
  if (reason === "SIGINT" || reason === "Global Timeout") {
    const finalState = reason === "SIGINT" ? "Aborted" : "Timeout";
    const finalMessage = reason === "SIGINT" 
      ? "Process aborted by user (SIGINT)." 
      : "Execution aborted by Global Watchdog (Timeout).";

    APP_STATE.servers.forEach(s => {
      if (["Queued", "Pinging", "Checking SSH", "Checking State", "Running"].includes(s.currentPhase)) {
        s.status = finalState;
        s.currentPhase = finalState;
        s.outputBuffer.push(finalMessage);
      }
    });
  }

  // Teardown TUI
  if (!IS_UNATTENDED && APP_STATE.servers.length > 0) {
    APP_STATE.servers.forEach((s, i) => updateGridCell(s, i));
    Terminal.leaveAltScreen();
    Terminal.showCursor();
  }

  // Calculate Exit Code based on Gold Principles
  const exitContributors = APP_STATE.servers.filter(s => s.status !== "Success" && s.status !== "Skipped");
  const skippedCount = APP_STATE.servers.filter(s => s.status === "Skipped").length;
  const totalFailures = exitContributors.length;
  const exitCode = Math.min(totalFailures, 255);

  // Create persistent timestamped log filename
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0]; // format: YYYYMMDDTHHMMSS
  const runLogPath = `${LOG_DIR}/run_${timestamp}.json`;

  // Render Final Summary
  if (!IS_UNATTENDED && APP_STATE.servers.length > 0) {
    console.log(colors.bold.cyan("\n=== Execution Summary ==="));
    if (reason === "SIGINT") console.log(colors.bgRed.white(" *** EXECUTION ABORTED BY USER *** "));
    if (reason === "Global Timeout") console.log(colors.bgRed.white(" *** EXECUTION TIMED OUT *** "));
    if (IS_DRY_RUN) console.log(colors.yellow("Note: This was a DRY RUN. No commands were actually executed."));
    if (IS_FORCED) console.log(colors.red("Note: FORCE mode was active. Idempotency checks were bypassed."));
    
    console.log(`\nTotal Targets: ${APP_STATE.servers.length}`);
    console.log(`Success:       ${colors.green((APP_STATE.servers.length - totalFailures - skippedCount).toString())}`);
    console.log(`Skipped:       ${colors.gray(skippedCount.toString())} (Informational)`);
    console.log(`Failures:      ${totalFailures > 0 ? colors.red(totalFailures.toString()) : "0"} (Exit Code Contributors)`);

    if (totalFailures > 0) {
      console.log(colors.red('\nNon-success servers:'));
      exitContributors.forEach(s => {
        const outColor = (s.status === "Aborted" || s.status === "Timeout") ? colors.magenta : colors.red;
        console.log(` - ${colors.bold(s.config.name)}: ${outColor(s.status)}`);
      });
    } else {
      console.log(colors.green("\nExecution complete: All systems operational or skipped cleanly."));
    }
    
    // Announce persistent log location
    console.log(colors.cyan(`\nPersistent Audit Log: ${runLogPath}`));
  }

  // Persist final state to structured JSON file
  try {
    await Deno.writeTextFile(runLogPath, JSON.stringify(APP_STATE.servers, null, 2));
  } catch (_e) {}

  Deno.exit(exitCode);
}

Deno.addSignalListener("SIGINT", () => {
  gracefulShutdown("SIGINT");
});


async function executeServerTask(server: ServerStatus): Promise<void> {
  if (APP_STATE.isShuttingDown) return; // Generation Guard against post-interrupt execution
  if (server.status === "Skipped" || server.status === "Offline" || server.status === "Aborted" || server.status === "Timeout") return;

  server.currentPhase = "Pinging";
  await logToFile(server.config.name, `--- Starting Task [${TARGET_COMMAND_NAME}] ---`);

  if (!(await pingHost(server.config))) {
    server.status = "Offline";
    server.outputBuffer.push("Host unreachable (ping failed).");
    return;
  }

  if (APP_STATE.isShuttingDown) return;

  const sshArgs = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    `${server.config.user}@${server.config.ip}`
  ];

  if (TARGET_COMMAND_TYPE !== "local") {
    server.currentPhase = "Checking SSH";
    try {
      const authCmd = new Deno.Command("ssh", { 
        args: [...sshArgs, "exit"], 
        stdout: "null", 
        stderr: "null",
        signal: APP_STATE.abortController.signal
      });
      if (!(await authCmd.output()).success) {
        server.status = "Failed";
        server.outputBuffer.push("Auth failed. Missing/invalid SSH keys.");
        return;
      }
    } catch (_e) {
      if (APP_STATE.isShuttingDown) return;
      server.status = "Failed";
      server.outputBuffer.push("SSH connection dropped.");
      return;
    }
  }

  if (APP_STATE.isShuttingDown) return;

  // Idempotency check logic with FORCE override
  if (TARGET_CHECK_COMMAND && !IS_FORCED) {
    server.currentPhase = "Checking State";
    const renderedCheck = renderTemplate(TARGET_CHECK_COMMAND, server.config);
    
    try {
      const checkCmd = TARGET_COMMAND_TYPE === "local" 
        ? new Deno.Command("sh", { args: ["-c", renderedCheck], stdout: "null", stderr: "null", signal: APP_STATE.abortController.signal })
        : new Deno.Command("ssh", { args: [...sshArgs, renderedCheck], stdout: "null", stderr: "null", signal: APP_STATE.abortController.signal });

      if ((await checkCmd.output()).success) {
        server.status = "Skipped"; 
        server.currentPhase = "Success";
        server.outputBuffer.push("State already met. Skipped.");
        return;
      }
    } catch (_e) {
      if (APP_STATE.isShuttingDown) return;
    }
  }

  const renderedCommand = renderTemplate(TARGET_COMMAND, server.config);

  if (IS_DRY_RUN) {
    server.status = "Success";
    server.currentPhase = "Success";
    server.outputBuffer.push(`[DRY RUN] Would execute:`);
    server.outputBuffer.push(renderedCommand);
    await logToFile(server.config.name, `[DRY RUN] Skipped execution of: ${renderedCommand}`);
    return;
  }

  server.currentPhase = "Running";
  
  try {
    const command = TARGET_COMMAND_TYPE === "local"
      ? new Deno.Command("sh", { args: ["-c", renderedCommand], stdout: "piped", stderr: "piped", signal: APP_STATE.abortController.signal })
      : new Deno.Command("ssh", { args: [...sshArgs, renderedCommand], stdout: "piped", stderr: "piped", signal: APP_STATE.abortController.signal });

    const child = command.spawn();

    const readStream = async (stream: ReadableStream<Uint8Array>, isErr: boolean) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let partial = "";
      try {
        while (true) {
          if (APP_STATE.isShuttingDown) break; // Guard against reading after interrupt
          const { value, done } = await reader.read();
          if (done) break;
          const lines = (partial + decoder.decode(value, { stream: true })).split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) {
              server.outputBuffer.push(line);
              if (IS_VERBOSE) await logToFile(server.config.name, `${isErr ? "[STDERR]" : "[STDOUT]"} ${line.trim()}`);
            }
          }
        }
      } catch (_e) {
        // Handle abort errors silently
      } finally { reader.releaseLock(); }
    };

    await Promise.all([readStream(child.stdout, false), readStream(child.stderr, true)]);
    
    if (APP_STATE.isShuttingDown) {
      try { child.kill("SIGTERM"); } catch (_) {}
      return; 
    }

    const success = (await child.status).success;
    server.status = success ? "Success" : "Failed";
    server.currentPhase = success ? "Success" : "Failed";

  } catch (_e) {
    if (APP_STATE.isShuttingDown) return;
    server.status = "Failed";
    server.currentPhase = "Failed";
    server.outputBuffer.push("Command execution failed or aborted.");
  }

  if (server.status === "Success" && TARGET_POST_COMMAND) {
    const renderedPost = renderTemplate(TARGET_POST_COMMAND, server.config, "PASSED");
    try {
      const postCmd = new Deno.Command("sh", { 
        args: ["-c", renderedPost], 
        stdout: "null", 
        stderr: "piped",
        signal: APP_STATE.abortController.signal 
      });
      const postResult = await postCmd.output();
      if (!postResult.success) {
        const errText = new TextDecoder().decode(postResult.stderr).trim();
        const failMsg = `[POST_COMMAND FAILED] ${errText || renderedPost}`;
        if (IS_UNATTENDED) {
          await logToFile(server.config.name, failMsg);
        } else {
          server.outputBuffer.push(`\x1b[7m\x1b[37m\x1b[41m${failMsg}\x1b[0m`);
        }
      }
    } catch (e: any) {
      if (APP_STATE.isShuttingDown) return;
      const failMsg = `[POST_COMMAND ERROR] ${e.message}`;
      if (IS_UNATTENDED) {
        await logToFile(server.config.name, failMsg);
      } else {
        server.outputBuffer.push(`\x1b[7m\x1b[37m\x1b[41m${failMsg}\x1b[0m`);
      }
    }
  }
}

async function main() {
  try {
    initDirectories();
    await pruneOldLogs(); // Clean up old historical runs immediately

    const { options, args } = await new Command()
      .name("axon")
      .version(VERSION)
      .description("Run commands on multiple servers based on tags.")
      .arguments('<command_name:string>')
      .option("-c, --config <file:string>", "Path to config", { default: `${HOME}/.axon_config.yml` })
      .option("-t, --tag <tag:string>", "Target by tag")
      .option("-s, --server <server:string>", "Target by server name")
      .option("-u, --unattended", "Run silently without TUI")
      .option("-v, --verbose", "Enable verbose logging")
      .option("-d, --dry-run", "Simulate execution without modifying the remote servers")
      .option("-f, --force", "Ignore idempotency check")
      .option("--no-check", "Alias for --force")
      .parse(Deno.args);

    if (options.tag && options.server && !["commands", "servers"].includes(args[0])) {
      fatal("Error: Cannot use both --tag and --server.");
    }

    IS_UNATTENDED = !!options.unattended;
    IS_VERBOSE = !!options.verbose;
    IS_DRY_RUN = !!options.dryRun;
    IS_FORCED = !!(options.force || options.noCheck);
    TARGET_COMMAND_NAME = args[0];

    const rawYaml = await Deno.readTextFile(options.config).catch(() => fatal(`Error: Could not read ${options.config}`));
    const parsedData = parseYaml(rawYaml);
    validateYamlConfig(parsedData, options.config);

    if (TARGET_COMMAND_NAME === "commands") return listAvailableCommands(parsedData, options);
    if (TARGET_COMMAND_NAME === "servers") return listAvailableServers(parsedData, options);

    const cmdConfig = parsedData.commands.find((c) => c.name === TARGET_COMMAND_NAME || c.aliases?.includes(TARGET_COMMAND_NAME));
    if (!cmdConfig) fatal(`Error: Command '${TARGET_COMMAND_NAME}' not found.`);

    TARGET_COMMAND = cmdConfig.command;
    TARGET_CHECK_COMMAND = cmdConfig.check_command;
    TARGET_POST_COMMAND = cmdConfig.post_command;
    TARGET_COMMAND_TYPE = cmdConfig.type || "remote";

    let targetServers = parsedData.servers.filter(s => s.active);
    if (options.server) {
      targetServers = targetServers.filter(s => s.name === options.server);
      if (!targetServers.length) fatal(`Error: Server '${options.server}' not found or active.`);
    } else if (options.tag) {
      targetServers = targetServers.filter(s => s.tags.includes(options.tag!));
    } else {
      targetServers = targetServers.filter(s => s.tags.some(tag => cmdConfig.tags.includes(tag)));
    }

    if (!targetServers.length) {
      console.log(colors.yellow(`No active servers found for the requested criteria.`));
      Deno.exit(0);
    }

    APP_STATE.servers = targetServers.map(config => ({
      config, status: "Success", currentPhase: "Queued", outputBuffer: ["Queued for execution."]
    }));

    if (!IS_UNATTENDED) {
      calculateLayout(APP_STATE.servers.length);
      Terminal.enterAltScreen();
      drawStaticLayout(APP_STATE.servers);
      APP_STATE.uiInterval = setInterval(() => APP_STATE.servers.forEach((s, i) => updateGridCell(s, i)), 100);
    } else {
      await logToFile(AXON_LOG, `[Unattended Mode] Executing '${TARGET_COMMAND_NAME}'`);
    }

    // Initialize Global Watchdog
    const globalWatchdog = setTimeout(() => {
      gracefulShutdown("Global Timeout");
    }, GLOBAL_TIMEOUT_MS);

    // Execution Chunker
    for (let i = 0; i < APP_STATE.servers.length; i += 10) {
      if (APP_STATE.isShuttingDown) break;
      await Promise.all(APP_STATE.servers.slice(i, i + 10).map(executeServerTask));
    }

    // Clear Watchdog upon natural completion
    clearTimeout(globalWatchdog);

    // Stop the UI interval because tasks are done and data is static
    if (APP_STATE.uiInterval) {
      clearInterval(APP_STATE.uiInterval);
      APP_STATE.uiInterval = undefined;
    }
    
    // Mark as completed to protect the final prompt from resize events
    APP_STATE.isCompleted = true;

    // Wait for operator input before tearing down if UI is active
    if (!APP_STATE.isShuttingDown && !IS_UNATTENDED) {
      drawCompletionMessage();
      if (Deno.stdin.isTerminal()) {
        try { Deno.stdin.setRaw(true); } catch {}
        await Deno.stdin.read(new Uint8Array(1));
        try { Deno.stdin.setRaw(false); } catch {}
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Trigger graceful completion
    await gracefulShutdown("Completed");

  } catch (error: any) {
    console.error(colors.bgRed.white(`\n  Critical Exception: ${error.message}  `));
    await gracefulShutdown("Error");
  }
}

await main();