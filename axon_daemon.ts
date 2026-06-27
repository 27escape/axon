#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run --allow-write --allow-net --allow-sys
// axon_daemon
/**
 * Axon Daemon: Multi-Node Parallel SSH Executor (Enterprise Control Plane)
 * Phase 10: Watchtower Background Health Monitoring + Strict AND Targeting Logic.
 */

const VERSION = "10.0.1";

import { colors, Command, parseYaml } from "./deps.ts";
import mqtt from "npm:mqtt@^5.5.0";
import { logger, setLogLevel, setLogFile } from "../various_tools/lib/logger.ts";

interface CommandConfig { name: string; aliases?: string[]; check_command?: string; command: string; post_command?: string; tags: string[]; type?: "remote" | "local"; }
interface ServerConfig { name: string; ip: string; user: string; active: boolean; tags: string[]; }
interface YamlConfig { commands: CommandConfig[]; servers: ServerConfig[]; }

interface ServerStatus {
  config: ServerConfig;
  status: "Success" | "Failed" | "Skipped" | "Offline" | "Aborted" | "Timeout";
  currentPhase: "Queued" | "Pinging" | "Checking SSH" | "Checking State" | "Running" | "Success" | "Failed" | "Aborted" | "Timeout";
  outputBuffer: string[];
}

interface DispatchPayload { 
  command: string; 
  targets?: { servers?: string[]; tags?: string[] }; 
  triggeredBy?: string; 
  isDryRun?: boolean; 
  isForced?: boolean; 
}

// --- Global Daemon State ---
const DAEMON_ID = `daemon_${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}`;
const MQTT_BROKER = Deno.env.get("MQTT_BROKER") || "mqtt://127.0.0.1:8884";
const MQTT_USER = Deno.env.get("MQTT_USER") || "axon_engine";
const MQTT_PASS = Deno.env.get("MQTT_PASS") || "engine123";
const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000;

const DAEMON_STATE = {
  isShuttingDown: false,
  mqttClient: mqtt.connect(MQTT_BROKER, { clientId: `axon_${DAEMON_ID}`, username: MQTT_USER, password: MQTT_PASS, connectTimeout: 5000 }),
  parsedConfig: null as YamlConfig | null,
  configPath: ""
};

// --- FIFO Queue State ---
const JOB_QUEUE: DispatchPayload[] = [];
let IS_PROCESSING = false;

interface ActiveJob { 
  runId: string; 
  payload: DispatchPayload; 
  cmdConfig: CommandConfig; 
  servers: ServerStatus[]; 
  abortController: AbortController; 
  timeoutWatchdog?: number; 
}
let ACTIVE_JOB: ActiveJob | null = null;

// --- Directory Setup & Tier 1 Persistence ---
const HOME = Deno.env.get("HOME") || "/root";
const STATE_DIR = `${HOME}/.local/state/axon`;
const LOG_DIR = `${STATE_DIR}/logs`;
const DOWNLOADS_DIR = `${STATE_DIR}/downloads`;

function initDirectories() {
  try { 
    Deno.mkdirSync(LOG_DIR, { recursive: true }); 
    Deno.mkdirSync(DOWNLOADS_DIR, { recursive: true }); 
    setLogFile(`${LOG_DIR}/axon_daemon`); 
  } catch (_e) {
    // Directories likely already exist
  }
}

// --- Configuration Engine (Hot-Reloading) ---
function validateYamlConfig(data: unknown): asserts data is YamlConfig {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid YAML structure. Expected root object.");
  }
  const root = data as Record<string, unknown>;
  if (!Array.isArray(root.commands)) {
    throw new Error("'commands' must be a valid array.");
  }
  if (!Array.isArray(root.servers)) {
    throw new Error("'servers' must be a valid array.");
  }
}

async function loadConfig(isInitialLoad = false) {
  try {
    const rawYaml = await Deno.readTextFile(DAEMON_STATE.configPath);
    const parsed = parseYaml(rawYaml);
    validateYamlConfig(parsed);
    DAEMON_STATE.parsedConfig = parsed;
    
    if (isInitialLoad) {
      logger.info(`[CONFIG] Initial configuration loaded from ${DAEMON_STATE.configPath}`);
    } else {
      logger.info(`[CONFIG] Hot-reload successful. Engine updated seamlessly.`);
    }
  } catch (e: any) {
    if (isInitialLoad) { 
      logger.fatal(`[CONFIG] Initial load failed: ${e.message}`); 
      Deno.exit(1); 
    } else {
      logger.error(`[CONFIG] Hot-reload failed: ${e.message}. Retaining previous valid configuration.`);
    }
  }
}

async function watchConfig() {
  try {
    const watcher = Deno.watchFs(DAEMON_STATE.configPath);
    for await (const event of watcher) {
      if (event.kind === "modify") {
        logger.trace(`[CONFIG] File system 'modify' event detected.`);
        await new Promise(r => setTimeout(r, 200)); 
        await loadConfig();
      }
    }
  } catch (e: any) { 
    logger.error(`[CONFIG] Watcher encountered an error: ${e.message}`); 
  }
}

// --- Network Utilities ---
async function pingHost(server: ServerConfig, signal?: AbortSignal): Promise<boolean> {
  const isMac = Deno.build.os === "darwin";
  try {
    const command = new Deno.Command("ping", { 
      args: ["-c", "1", "-W", isMac ? "2000" : "2", server.ip], 
      stdout: "null", 
      stderr: "null", 
      signal 
    });
    const output = await command.output();
    return output.success;
  } catch (_e) { 
    return true; // Fail-open on OS constraint errors so we don't accidentally block execution
  } 
}

// --- WATCHTOWER: Fleet Health Monitoring ---
async function checkFleetHealth() {
  if (!DAEMON_STATE.parsedConfig || DAEMON_STATE.isShuttingDown) return;
  
  const activeServers = DAEMON_STATE.parsedConfig.servers.filter(s => s.active);
  if (activeServers.length === 0) return;

  logger.debug(`[WATCHTOWER] Initiating background health sweep of ${activeServers.length} active servers...`);
  const healthState: Record<string, "Online" | "Offline"> = {};
  
  const abortController = new AbortController();
  // Set a hard 10-second timeout for the entire sweep so it never blocks
  const sweepWatchdog = setTimeout(() => abortController.abort(), 10000);

  await Promise.all(activeServers.map(async (server) => {
    try {
      const isAlive = await pingHost(server, abortController.signal);
      healthState[server.name] = isAlive ? "Online" : "Offline";
    } catch (_e) {
      healthState[server.name] = "Offline";
    }
  }));

  clearTimeout(sweepWatchdog);

  if (!DAEMON_STATE.isShuttingDown) {
    DAEMON_STATE.mqttClient.publish('axon/fleet/health', JSON.stringify({
      timestamp: Date.now(),
      status: healthState
    }), { qos: 1, retain: true });
    
    logger.debug(`[WATCHTOWER] Fleet sweep complete. Results published to MQTT.`);
  }
}

// --- MQTT Broadcasters (Scoped to Active Job) ---
function publishState() {
  if (!ACTIVE_JOB) return;
  const payload = JSON.stringify({ 
    state: ACTIVE_JOB.servers, 
    isDryRun: !!ACTIVE_JOB.payload.isDryRun, 
    isForced: !!ACTIVE_JOB.payload.isForced 
  });
  DAEMON_STATE.mqttClient.publish(`axon/run/${ACTIVE_JOB.runId}/state`, payload, { qos: 1, retain: true });
}

function updateServerState(index: number, modifier: (s: ServerStatus) => void) {
  if (!ACTIVE_JOB) return; 
  modifier(ACTIVE_JOB.servers[index]); 
  publishState();
}

function broadcastLog(serverName: string, message: string) {
  if (!ACTIVE_JOB) return; 
  DAEMON_STATE.mqttClient.publish(`axon/run/${ACTIVE_JOB.runId}/log/${serverName}`, message, { qos: 0 });
}

function renderTemplate(template: string, server: ServerConfig, commandName: string, status?: string): string {
  return template
    .replace(/\{\{home\}\}/g, HOME)
    .replace(/\{\{ip\}\}/g, server.ip)
    .replace(/\{\{user\}\}/g, server.user)
    .replace(/\{\{server_name\}\}/g, server.name)
    .replace(/\{\{downloads\}\}/g, DOWNLOADS_DIR)
    .replace(/\{\{name\}\}/g, commandName)
    .replace(/\{\{status\}\}/g, status ?? "");
}

// --- The Execution Engine (Per-Server) ---
async function executeServerTask(index: number): Promise<void> {
  const job = ACTIVE_JOB;
  if (!job || DAEMON_STATE.isShuttingDown) return;
  
  const server = job.servers[index];
  if (["Skipped", "Offline", "Aborted", "Timeout"].includes(server.status)) return;

  updateServerState(index, s => { s.currentPhase = "Pinging"; });
  logger.info(`[${server.config.name}] Starting Task: ${job.cmdConfig.name}`);

  if (!(await pingHost(server.config, job.abortController.signal))) {
    logger.warn(`[${server.config.name}] Host unreachable.`);
    updateServerState(index, s => { 
      s.status = "Offline"; 
      s.outputBuffer.push("Host unreachable."); 
    });
    return;
  }

  if (DAEMON_STATE.isShuttingDown || job.abortController.signal.aborted) return;
  
  const sshArgs = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", `${server.config.user}@${server.config.ip}`];

  if ((job.cmdConfig.type || "remote") !== "local") {
    updateServerState(index, s => { s.currentPhase = "Checking SSH"; });
    try {
      const authCmd = new Deno.Command("ssh", { 
        args: [...sshArgs, "exit"], 
        stdout: "null", 
        stderr: "null", 
        signal: job.abortController.signal 
      });
      if (!(await authCmd.output()).success) {
        updateServerState(index, s => { 
          s.status = "Failed"; 
          s.outputBuffer.push("Auth failed."); 
        });
        return;
      }
    } catch (_e) {
      if (!DAEMON_STATE.isShuttingDown) {
        updateServerState(index, s => { 
          s.status = "Failed"; 
          s.outputBuffer.push("SSH connection dropped."); 
        });
      }
      return;
    }
  }

  if (DAEMON_STATE.isShuttingDown || job.abortController.signal.aborted) return;

  if (job.cmdConfig.check_command && !job.payload.isForced) {
    updateServerState(index, s => { s.currentPhase = "Checking State"; });
    const renderedCheck = renderTemplate(job.cmdConfig.check_command, server.config, job.cmdConfig.name);
    try {
      const checkCmd = (job.cmdConfig.type || "remote") === "local" 
        ? new Deno.Command("sh", { args: ["-c", renderedCheck], stdout: "null", stderr: "null", signal: job.abortController.signal })
        : new Deno.Command("ssh", { args: [...sshArgs, renderedCheck], stdout: "null", stderr: "null", signal: job.abortController.signal });

      if ((await checkCmd.output()).success) {
        updateServerState(index, s => { 
          s.status = "Skipped"; 
          s.currentPhase = "Success"; 
          s.outputBuffer.push("State already met. Skipped."); 
        });
        return;
      }
    } catch (_e) {}
  }

  const renderedCommand = renderTemplate(job.cmdConfig.command, server.config, job.cmdConfig.name);

  if (job.payload.isDryRun) {
    updateServerState(index, s => { 
      s.status = "Success"; 
      s.currentPhase = "Success"; 
      s.outputBuffer.push(`[DRY RUN] Would execute:`, renderedCommand); 
    });
    return;
  }

  updateServerState(index, s => { s.currentPhase = "Running"; });
  
  try {
    const command = (job.cmdConfig.type || "remote") === "local"
      ? new Deno.Command("sh", { args: ["-c", renderedCommand], stdout: "piped", stderr: "piped", signal: job.abortController.signal })
      : new Deno.Command("ssh", { args: [...sshArgs, renderedCommand], stdout: "piped", stderr: "piped", signal: job.abortController.signal });

    const child = command.spawn();

    const readStream = async (stream: ReadableStream<Uint8Array>, isErr: boolean) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let partial = "";
      try {
        while (true) {
          if (DAEMON_STATE.isShuttingDown || job.abortController.signal.aborted) break;
          const { value, done } = await reader.read();
          if (done) break;
          
          const lines = (partial + decoder.decode(value, { stream: true })).split("\n");
          partial = lines.pop() ?? "";
          
          for (const line of lines) {
            if (line.trim()) {
              updateServerState(index, s => { s.outputBuffer.push(line); });
              broadcastLog(server.config.name, `${isErr ? "[STDERR]" : "[STDOUT]"} ${line.trim()}`);
            }
          }
        }
      } catch (_e) {
        // Stream read error
      } finally { 
        reader.releaseLock(); 
      }
    };

    await Promise.all([
      readStream(child.stdout, false), 
      readStream(child.stderr, true)
    ]);
    
    if (DAEMON_STATE.isShuttingDown || job.abortController.signal.aborted) { 
      try { child.kill("SIGTERM"); } catch (_) {} 
      return; 
    }

    const success = (await child.status).success;
    updateServerState(index, s => { 
      s.status = success ? "Success" : "Failed"; 
      s.currentPhase = success ? "Success" : "Failed"; 
    });

  } catch (e: any) {
    if (!DAEMON_STATE.isShuttingDown && !job.abortController.signal.aborted) {
      updateServerState(index, s => { 
        s.status = "Failed"; 
        s.currentPhase = "Failed"; 
        s.outputBuffer.push("Command execution failed."); 
      });
    }
  }
}

// --- The Job Queue Manager (MULTI-TARGET LOGIC UPGRADE) ---
async function processQueue() {
  if (IS_PROCESSING || JOB_QUEUE.length === 0 || !DAEMON_STATE.parsedConfig) return;
  IS_PROCESSING = true;

  while (JOB_QUEUE.length > 0 && !DAEMON_STATE.isShuttingDown) {
    const payload = JOB_QUEUE.shift()!;
    logger.info(`[QUEUE] Processing Job: '${payload.command}'`);

    const cmdConfig = DAEMON_STATE.parsedConfig.commands.find(c => c.name === payload.command || c.aliases?.includes(payload.command));
    if (!cmdConfig) { 
      logger.error(`Job Failed: Command '${payload.command}' not found in configuration.`); 
      continue; 
    }

    let targetServers = DAEMON_STATE.parsedConfig.servers.filter(s => s.active);

    // MULTI-TARGET LOGIC UPGRADE (Strict Intersection / AND Logic)
    if (payload.targets && (Array.isArray(payload.targets.servers) || Array.isArray(payload.targets.tags))) {
      const explicitServers = payload.targets.servers || [];
      const explicitTags = payload.targets.tags || [];
      
      if (explicitServers.length > 0 && explicitTags.length > 0) {
        // AND Logic: Must be in the explicit server list AND have the requested tags
        targetServers = targetServers.filter(s => 
          explicitServers.includes(s.name) && s.tags.some(tag => explicitTags.includes(tag))
        );
      } else if (explicitServers.length > 0) {
        // Only servers specified
        targetServers = targetServers.filter(s => explicitServers.includes(s.name));
      } else if (explicitTags.length > 0) {
        // Only tags specified
        targetServers = targetServers.filter(s => s.tags.some(tag => explicitTags.includes(tag)));
      }
    } else {
      // Fallback: Run on servers matching the command's default tags
      targetServers = targetServers.filter(s => s.tags.some(tag => cmdConfig.tags.includes(tag)));
    }

    if (!targetServers.length) { 
      logger.warn(`Job Skipped: No active servers match targets for '${payload.command}'.`); 
      continue; 
    }

    const runId = `run_${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}_${Math.floor(Math.random() * 1000)}`;
    
    ACTIVE_JOB = {
      runId, 
      payload, 
      cmdConfig, 
      abortController: new AbortController(),
      servers: targetServers.map(config => ({ 
        config, 
        status: "Success", 
        currentPhase: "Queued", 
        outputBuffer: ["Queued for execution."] 
      }))
    };

    logger.info(`[JOB STARTED] Run ID: ${runId}`);
    
    DAEMON_STATE.mqttClient.publish(`axon/run/${runId}/status`, JSON.stringify({ status: "running" }), { retain: true, qos: 1 });
    DAEMON_STATE.mqttClient.publish(`axon/runs/latest`, JSON.stringify({ run_id: runId }), { retain: true, qos: 1 });
    publishState();

    ACTIVE_JOB.timeoutWatchdog = setTimeout(() => {
      if (ACTIVE_JOB) { 
        logger.error(`[TIMEOUT] Job ${runId} exceeded global timeout.`); 
        ACTIVE_JOB.abortController.abort(); 
      }
    }, GLOBAL_TIMEOUT_MS);

    for (let i = 0; i < ACTIVE_JOB.servers.length; i += 10) {
      if (DAEMON_STATE.isShuttingDown || ACTIVE_JOB.abortController.signal.aborted) break;
      await Promise.all(ACTIVE_JOB.servers.slice(i, i + 10).map((_, idx) => executeServerTask(i + idx)));
    }

    clearTimeout(ACTIVE_JOB.timeoutWatchdog);

    const exitContributors = ACTIVE_JOB.servers.filter(s => s.status !== "Success" && s.status !== "Skipped");
    const skippedCount = ACTIVE_JOB.servers.filter(s => s.status === "Skipped").length;
    const failures = exitContributors.length;
    
    const runLogPath = `${LOG_DIR}/${runId}.json`;
    const summaryPayload = {
      status: "completed", 
      exitCode: Math.min(failures, 255), 
      runLogPath, 
      totalTargets: ACTIVE_JOB.servers.length,
      success: ACTIVE_JOB.servers.length - failures - skippedCount, 
      skipped: skippedCount, 
      failures,
      failedServers: exitContributors.map(s => ({ name: s.config.name, status: s.status }))
    };

    DAEMON_STATE.mqttClient.publish(`axon/run/${runId}/status`, JSON.stringify(summaryPayload), { qos: 1, retain: true });
    
    try { 
      await Deno.writeTextFile(runLogPath, JSON.stringify(ACTIVE_JOB.servers, null, 2)); 
    } catch (_e) {
      logger.error(`Failed to write local log file for run ${runId}`);
    }

    logger.info(`[JOB COMPLETED] Run ID: ${runId}. Failures: ${failures}`);
    ACTIVE_JOB = null; 
  }
  IS_PROCESSING = false;
}

// --- Graceful Daemon Teardown ---
async function gracefulShutdown(reason: string): Promise<never> {
  if (DAEMON_STATE.isShuttingDown) await new Promise(() => {});
  DAEMON_STATE.isShuttingDown = true;
  logger.info(`Initiating daemon shutdown. Reason: ${reason}`);
  
  if (ACTIVE_JOB) {
    ACTIVE_JOB.abortController.abort(); 
  }

  const failsafe = setTimeout(() => { 
    logger.fatal("Shutdown deadlock. Forcing exit."); 
    Deno.exit(1); 
  }, 3000);
  
  try { 
    await DAEMON_STATE.mqttClient.endAsync(true); 
  } catch (_e) {
    // Ignore MQTT disconnect errors on teardown
  }
  
  clearTimeout(failsafe);
  logger.info(`Daemon terminated.`);
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", () => gracefulShutdown("SIGINT"));
Deno.addSignalListener("SIGTERM", () => gracefulShutdown("SIGTERM"));

// --- Boot Sequence ---
async function main() {
  try {
    const { options } = await new Command()
      .name("axon_daemon")
      .version(VERSION)
      .option("-c, --config <file:string>", "Path to config", { default: `${HOME}/.axon_config.yml` })
      .option("-v, --verbose", "Enable trace/debug logging via custom logger")
      .parse(Deno.args);

    setLogLevel(options.verbose ? "trace" : "info");
    initDirectories();
    DAEMON_STATE.configPath = options.config;
    
    await loadConfig(true);
    watchConfig().catch(e => logger.error(`[CONFIG] Watcher failed: ${e.message}`));

    logger.debug("Establishing MQTT connection...");
    if (!DAEMON_STATE.mqttClient.connected) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MQTT Timeout`)), 5000);
        DAEMON_STATE.mqttClient.once('connect', () => { 
          clearTimeout(timeout); 
          resolve(); 
        });
        DAEMON_STATE.mqttClient.once('error', (err) => { 
          clearTimeout(timeout); 
          reject(err); 
        });
      });
    }

    DAEMON_STATE.mqttClient.subscribe('axon/control/dispatch', { qos: 1 });

    DAEMON_STATE.mqttClient.on('message', (topic, message) => {
      if (topic === 'axon/control/dispatch') {
        try {
          const payload = JSON.parse(message.toString()) as DispatchPayload;
          JOB_QUEUE.push(payload);
          logger.info(`[DISPATCH RECEIVED] Queued '${payload.command}'`);
          processQueue(); 
        } catch (e) { 
          logger.error(`Failed to parse dispatch payload.`); 
        }
      }
    });

    // --- START WATCHTOWER HEARTBEAT ---
    setInterval(() => {
      checkFleetHealth().catch(e => logger.error(`[WATCHTOWER] Internal sweep error: ${e.message}`));
    }, 60 * 1000);
    // Trigger initial sweep immediately upon boot
    checkFleetHealth();

    logger.info(`Axon Control Plane running. Connected to ${MQTT_BROKER}`);
    
    await new Promise(() => {}); // Keep alive
  } catch (error: any) {
    logger.fatal(`Critical Exception: ${error.message}`);
    Deno.exit(1);
  }
}

await main();