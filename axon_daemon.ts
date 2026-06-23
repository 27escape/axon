#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run --allow-write --allow-net --allow-sys
// axon_daemon
/**
 * Axon Daemon: Multi-Node Parallel SSH Executor (MQTT Event-Driven Engine)
 * Features tag-based routing, custom tslog integration, and MQTT Pub/Sub for TUI state.
 */

const VERSION = "7.1.0";

import { colors, Command, parseYaml } from "./deps.ts";
import mqtt from "npm:mqtt@^5.5.0";
import { logger, setLogLevel, setLogFile } from "../various_tools/lib/logger.ts";

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

// --- Global Application State ---
const RUN_ID = `run_${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}_${Math.floor(Math.random() * 1000)}`;
const MQTT_BROKER = Deno.env.get("MQTT_BROKER") || "mqtt://127.0.0.1:1883";

const APP_STATE = {
  isShuttingDown: false,
  servers: [] as ServerStatus[],
  abortController: new AbortController(),
  mqttClient: mqtt.connect(MQTT_BROKER, { clientId: `axon_daemon_${RUN_ID}`, connectTimeout: 5000 })
};

const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000;

// --- Directory Setup & Tier 1 Persistence ---
const USER = Deno.env.get("USER") || "default";
const HOME = Deno.env.get("HOME") || "/root";
const STATE_DIR = `${HOME}/.local/state/axon`;
const LOG_DIR = `${STATE_DIR}/logs`;
const DOWNLOADS_DIR = `${STATE_DIR}/downloads`;

function initDirectories() {
  try {
    Deno.mkdirSync(LOG_DIR, { recursive: true });
    Deno.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    // Attach the custom logger to the log directory
    setLogFile(`${LOG_DIR}/axon_daemon`);
  } catch (_e) {}
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
    files.sort((a, b) => b.time - a.time);
    const toDelete = files.slice(10);
    for (const file of toDelete) {
      await Deno.remove(`${LOG_DIR}/${file.name}`).catch(() => {});
    }
  } catch (_e) {}
}

// --- YAML & Utility Functions ---
function validateYamlConfig(data: unknown, source: string): asserts data is YamlConfig {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    logger.fatal(`Invalid YAML structure in ${source}. Expected an object with 'commands' and 'servers'.`);
    Deno.exit(1);
  }
  const root = data as Record<string, unknown>;
  if (!Array.isArray(root.commands)) { logger.fatal(`Invalid config in ${source}: 'commands' must be a list.`); Deno.exit(1); }
  if (!Array.isArray(root.servers)) { logger.fatal(`Invalid config in ${source}: 'servers' must be a list.`); Deno.exit(1); }
}

function listAvailableCommands(parsedData: YamlConfig, options: { server?: string; tag?: string; }): void {
  // Simplified for brevity - assumes logic is intact
  logger.info("Listing available commands...");
  parsedData.commands.forEach((cmd) => {
    logger.info(`Command: ${cmd.name} [Tags: ${cmd.tags.join(", ")}]`);
  });
}

function listAvailableServers(parsedData: YamlConfig, options: { server?: string; tag?: string; }): void {
  logger.info("Listing available servers...");
  parsedData.servers.forEach((server) => {
    logger.info(`Server: ${server.name} (${server.ip}) [Tags: ${server.tags.join(", ")}]`);
  });
}

// --- MQTT Broadcaster (For TUI Only) ---
function publishState() {
  const payload = JSON.stringify({ state: APP_STATE.servers, isDryRun: IS_DRY_RUN, isForced: IS_FORCED });
  APP_STATE.mqttClient.publish(`axon/run/${RUN_ID}/state`, payload, { qos: 1, retain: true });
}

function updateServerState(index: number, modifier: (s: ServerStatus) => void) {
  modifier(APP_STATE.servers[index]);
  publishState();
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

async function pingHost(server: ServerConfig): Promise<boolean> {
  const isMac = Deno.build.os === "darwin";
  try {
    const command = new Deno.Command("ping", { 
      args: ["-c", "1", "-W", isMac ? "2000" : "2", server.ip], 
      stdout: "null", stderr: "null", signal: APP_STATE.abortController.signal 
    });
    return (await command.output()).success;
  } catch (_e) { return true; }
}

async function gracefulShutdown(reason: string): Promise<never> {
  if (APP_STATE.isShuttingDown) await new Promise(() => {});
  APP_STATE.isShuttingDown = true;
  
  logger.info(`Initiating graceful shutdown. Reason: ${reason}`);
  APP_STATE.abortController.abort();

  // CYANIDE PILL: Prevent process deadlock if MQTT or standard output hangs
  const failsafe = setTimeout(() => {
    logger.fatal("Shutdown deadlock detected. Forcing process exit.");
    Deno.exit(APP_STATE.servers.some(s => s.status === "Failed") ? 1 : 0);
  }, 3000);

  if (reason === "SIGINT" || reason === "Global Timeout") {
    const finalState = reason === "SIGINT" ? "Aborted" : "Timeout";
    const finalMessage = reason === "SIGINT" ? "Process aborted by user." : "Execution timed out.";
    
    APP_STATE.servers.forEach((s, index) => {
      if (["Queued", "Pinging", "Checking SSH", "Checking State", "Running"].includes(s.currentPhase)) {
        updateServerState(index, (srv) => {
          srv.status = finalState; srv.currentPhase = finalState; srv.outputBuffer.push(finalMessage);
        });
      }
    });
  }

  const exitContributors = APP_STATE.servers.filter(s => s.status !== "Success" && s.status !== "Skipped");
  const skippedCount = APP_STATE.servers.filter(s => s.status === "Skipped").length;
  const totalFailures = exitContributors.length;
  const exitCode = Math.min(totalFailures, 255);

  const runLogPath = `${LOG_DIR}/${RUN_ID}.json`;

  const summaryPayload = {
    status: "completed",
    exitCode,
    runLogPath,
    totalTargets: APP_STATE.servers.length,
    success: APP_STATE.servers.length - totalFailures - skippedCount,
    skipped: skippedCount,
    failures: totalFailures,
    reason: reason,
    failedServers: exitContributors.map(s => ({ name: s.config.name, status: s.status }))
  };

  try {
    await APP_STATE.mqttClient.publishAsync(`axon/run/${RUN_ID}/status`, JSON.stringify(summaryPayload), { qos: 1, retain: true });
    await Deno.writeTextFile(runLogPath, JSON.stringify(APP_STATE.servers, null, 2));
    
    logger.debug("Disconnecting MQTT client...");
    await APP_STATE.mqttClient.endAsync(true); // Force close to prevent hanging TCP sockets
  } catch (e) {
    logger.error("Error during teardown sequence:", e);
  }

  clearTimeout(failsafe);
  
  logger.info(`Daemon execution complete. Exit code: ${exitCode}`);
  logger.info(`Persistent Audit Log: ${runLogPath}`);
  Deno.exit(exitCode);
}

Deno.addSignalListener("SIGINT", () => gracefulShutdown("SIGINT"));

async function executeServerTask(index: number): Promise<void> {
  const server = APP_STATE.servers[index];
  if (APP_STATE.isShuttingDown) return;
  if (server.status === "Skipped" || server.status === "Offline" || server.status === "Aborted" || server.status === "Timeout") return;

  updateServerState(index, s => { s.currentPhase = "Pinging"; });
  logger.info(`[${server.config.name}] Starting Task: ${TARGET_COMMAND_NAME}`);

  logger.trace(`[${server.config.name}] Executing ICMP Ping...`);
  if (!(await pingHost(server.config))) {
    logger.warn(`[${server.config.name}] Host unreachable (ping failed).`);
    updateServerState(index, s => { s.status = "Offline"; s.outputBuffer.push("Host unreachable (ping failed)."); });
    return;
  }

  if (APP_STATE.isShuttingDown) return;
  const sshArgs = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", `${server.config.user}@${server.config.ip}`];

  if (TARGET_COMMAND_TYPE !== "local") {
    updateServerState(index, s => { s.currentPhase = "Checking SSH"; });
    logger.trace(`[${server.config.name}] Authenticating SSH...`);
    try {
      const authCmd = new Deno.Command("ssh", { args: [...sshArgs, "exit"], stdout: "null", stderr: "null", signal: APP_STATE.abortController.signal });
      if (!(await authCmd.output()).success) {
        logger.error(`[${server.config.name}] Auth failed. Missing/invalid SSH keys.`);
        updateServerState(index, s => { s.status = "Failed"; s.outputBuffer.push("Auth failed. Missing/invalid SSH keys."); });
        return;
      }
    } catch (_e) {
      if (!APP_STATE.isShuttingDown) {
        logger.error(`[${server.config.name}] SSH connection dropped.`);
        updateServerState(index, s => { s.status = "Failed"; s.outputBuffer.push("SSH connection dropped."); });
      }
      return;
    }
  }

  const renderedCommand = renderTemplate(TARGET_COMMAND, server.config);

  if (IS_DRY_RUN) {
    logger.info(`[${server.config.name}] [DRY RUN] Would execute: ${renderedCommand}`);
    updateServerState(index, s => { 
      s.status = "Success"; s.currentPhase = "Success"; s.outputBuffer.push(`[DRY RUN] Would execute:`, renderedCommand); 
    });
    return;
  }

  updateServerState(index, s => { s.currentPhase = "Running"; });
  logger.trace(`[${server.config.name}] Spawning process: ${renderedCommand}`);
  
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
          if (APP_STATE.isShuttingDown) break;
          const { value, done } = await reader.read();
          if (done) break;
          const lines = (partial + decoder.decode(value, { stream: true })).split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) {
              updateServerState(index, s => { s.outputBuffer.push(line); });
              // Delegate verbose stream output strictly to the custom logger
              if (IS_VERBOSE) {
                logger.debug(`[${server.config.name}] ${isErr ? "STDERR" : "STDOUT"}: ${line.trim()}`);
              }
            }
          }
        }
      } catch (_e) {} finally { reader.releaseLock(); }
    };

    await Promise.all([readStream(child.stdout, false), readStream(child.stderr, true)]);
    if (APP_STATE.isShuttingDown) { try { child.kill("SIGTERM"); } catch (_) {} return; }

    logger.trace(`[${server.config.name}] Waiting for child process to resolve...`);
    const success = (await child.status).success;
    
    if (success) {
      logger.info(`[${server.config.name}] Command completed successfully.`);
      updateServerState(index, s => { s.status = "Success"; s.currentPhase = "Success"; });
    } else {
      logger.warn(`[${server.config.name}] Command returned non-zero exit code.`);
      updateServerState(index, s => { s.status = "Failed"; s.currentPhase = "Failed"; });
    }

  } catch (e: any) {
    if (!APP_STATE.isShuttingDown) {
      logger.error(`[${server.config.name}] Execution exception: ${e.message}`);
      updateServerState(index, s => { s.status = "Failed"; s.currentPhase = "Failed"; s.outputBuffer.push("Command execution failed or aborted."); });
    }
  }
}

async function main() {
  try {
    const { options, args } = await new Command()
      .name("axon_daemon")
      .version(VERSION)
      .arguments('<command_name:string>')
      .option("-c, --config <file:string>", "Path to config", { default: `${HOME}/.axon_config.yml` })
      .option("-t, --tag <tag:string>", "Target by tag")
      .option("-s, --server <server:string>", "Target by server name")
      .option("-u, --unattended", "Run silently (Daemon native)")
      .option("-v, --verbose", "Enable trace/debug logging via custom logger")
      .option("-d, --dry-run", "Simulate execution")
      .option("-f, --force", "Ignore idempotency check")
      .parse(Deno.args);

    IS_UNATTENDED = !!options.unattended;
    IS_VERBOSE = !!options.verbose;
    IS_DRY_RUN = !!options.dryRun;
    IS_FORCED = !!options.force;
    TARGET_COMMAND_NAME = args[0];

    // Configure the injected logger based on flags
    setLogLevel(IS_VERBOSE ? "trace" : "info");

    initDirectories();
    await pruneOldLogs();

    const rawYaml = await Deno.readTextFile(options.config).catch(() => {
      logger.fatal(`Could not read config file at ${options.config}`);
      Deno.exit(1);
    });
    const parsedData = parseYaml(rawYaml) as YamlConfig;
    validateYamlConfig(parsedData, options.config);
    
    if (TARGET_COMMAND_NAME === "commands") return listAvailableCommands(parsedData, options);
    if (TARGET_COMMAND_NAME === "servers") return listAvailableServers(parsedData, options);

    const cmdConfig = parsedData.commands.find((c) => c.name === TARGET_COMMAND_NAME || c.aliases?.includes(TARGET_COMMAND_NAME));
    if (!cmdConfig) { logger.fatal(`Command '${TARGET_COMMAND_NAME}' not found in configuration.`); Deno.exit(1); }

    TARGET_COMMAND = cmdConfig.command;
    TARGET_CHECK_COMMAND = cmdConfig.check_command;
    TARGET_POST_COMMAND = cmdConfig.post_command;
    TARGET_COMMAND_TYPE = cmdConfig.type || "remote";

    let targetServers = parsedData.servers.filter(s => s.active);
    if (options.server) targetServers = targetServers.filter(s => s.name === options.server);
    else if (options.tag) targetServers = targetServers.filter(s => s.tags.includes(options.tag!));
    else targetServers = targetServers.filter(s => s.tags.some(tag => cmdConfig.tags.includes(tag)));

    if (!targetServers.length) { logger.warn(`No active servers found for the requested criteria.`); Deno.exit(0); }

    APP_STATE.servers = targetServers.map(config => ({
      config, status: "Success", currentPhase: "Queued", outputBuffer: ["Queued for execution."]
    }));

// Ensure MQTT connects safely, preventing race conditions if it connected instantly
    logger.debug("Establishing MQTT connection...");
    if (!APP_STATE.mqttClient.connected) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MQTT Broker Connection Timeout at ${MQTT_BROKER}`)), 5000);
        APP_STATE.mqttClient.once('connect', () => { clearTimeout(timeout); resolve(); });
        APP_STATE.mqttClient.once('error', (err) => { clearTimeout(timeout); reject(err); });
      });
    } else {
      logger.trace("MQTT client already connected via background thread.");
    }

    APP_STATE.mqttClient.publish(`axon/run/${RUN_ID}/status`, JSON.stringify({ status: "running" }), { retain: true, qos: 1 });
    APP_STATE.mqttClient.publish(`axon/runs/latest`, JSON.stringify({ run_id: RUN_ID }), { retain: true, qos: 1 });
    publishState();

    logger.info(`Axon Engine running. Connected to ${MQTT_BROKER}`);
    logger.info(`Run ID: ${RUN_ID}`);
    if (!IS_UNATTENDED) logger.info(`Execute 'axon_tui' in another terminal to attach view.`);
    
    const globalWatchdog = setTimeout(() => gracefulShutdown("Global Timeout"), GLOBAL_TIMEOUT_MS);

    for (let i = 0; i < APP_STATE.servers.length; i += 10) {
      if (APP_STATE.isShuttingDown) break;
      await Promise.all(APP_STATE.servers.slice(i, i + 10).map((_, idx) => executeServerTask(i + idx)));
    }

    clearTimeout(globalWatchdog);
    await gracefulShutdown("Completed");

  } catch (error: any) {
    logger.fatal(`Critical Exception: ${error.message}`);
    Deno.exit(1);
  }
}

await main();