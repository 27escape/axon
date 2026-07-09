#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-sys
/**
 * Axon CLI: Command Line Interface for the Axon Control Plane
 * Synchronous executor with Watchtower fleet querying.
 */

const VERSION = "10.1.0";

import { Command, colors } from "./deps.ts";
import mqtt from "npm:mqtt@^5.5.0";
import { logger, setLogLevel } from "../various_tools/lib/logger.ts";

// --- Shared Interfaces ---
interface DispatchPayload { 
  command: string; 
  targets?: { servers?: string[]; tags?: string[] }; 
  triggeredBy?: string; 
  isDryRun?: boolean; 
  isForced?: boolean; 
}

// --- Environment Defaults ---
const MQTT_BROKER = Deno.env.get("MQTT_BROKER") || "mqtt://127.0.0.1:8884";
const MQTT_USER = Deno.env.get("MQTT_USER") || "axon_admin"; 
const MQTT_PASS = Deno.env.get("MQTT_PASS") || "admin123";

async function main() {
  try {
    const { options, args } = await new Command()
      .name("axon_cli")
      .version(VERSION)
      .description("Axon Control Plane CLI\nUse 'online' as the command to check fleet health.")
      .arguments("<command_name:string>")
      .option("-t, --tags <tag:string>", "Target specific tags (can be used multiple times)", { collect: true })
      .option("-s, --servers <server:string>", "Target specific servers (can be used multiple times)", { collect: true })
      .option("-v, --verbose", "Raise log level to debug")
      .option("-d, --dry-run", "Execute as a dry run")
      .option("-f, --force", "Force execution (bypasses idempotency checks)")
      .parse(Deno.args);

    setLogLevel(options.verbose ? "debug" : "info");
    const commandName = args[0];

    // --- Connect to MQTT Broker ---
    const client = mqtt.connect(MQTT_BROKER, { 
      clientId: `axon_cli_${Date.now()}`, 
      username: MQTT_USER, 
      password: MQTT_PASS,
      connectTimeout: 5000
    });

    client.on("error", (err) => {
      logger.fatal(`[CLI] MQTT Connection Error: ${err.message}`);
      client.end();
      Deno.exit(1);
    });

    client.on("connect", () => {
      logger.debug(`[CLI] Connected to broker at ${MQTT_BROKER}`);

      // ==========================================
      // FEATURE 1: Watchtower 'online' Check
      // ==========================================
      if (commandName.toLowerCase() === "online") {
        logger.debug("[CLI] Querying Watchtower for fleet health...");
        client.subscribe("axon/fleet/health");
        
        // Failsafe in case Watchtower hasn't published yet
        const timeout = setTimeout(() => {
          logger.error("Timeout waiting for Watchtower. Is the Axon Daemon running?");
          client.end();
          Deno.exit(1);
        }, 3000);

        client.on("message", (topic, message) => {
          if (topic === "axon/fleet/health") {
            clearTimeout(timeout);
            const data = JSON.parse(message.toString());
            
            console.log(`\n${colors.bold.cyan("AXON WATCHTOWER // Fleet Status")}`);
            console.log("-----------------------------------");
            
            for (const [server, status] of Object.entries(data.status)) {
              const isOnline = status === "Online";
              const statusBadge = isOnline ? colors.green("[ Online ]") : colors.red("[ Offline]");
              console.log(`${statusBadge} ${server}`);
            }
            console.log("-----------------------------------\n");
            
            client.end();
            Deno.exit(0);
          }
        });
        return; // Halt further execution
      }

      // ==========================================
      // FEATURE 2: Synchronous Command Dispatch
      // ==========================================
      const payload: DispatchPayload = {
        command: commandName,
        targets: { tags: options.tags || [], servers: options.servers || [] },
        triggeredBy: Deno.env.get("USER") || "axon_cli",
        isDryRun: options.dryRun || false,
        isForced: options.force || false
      };

      let activeRunId: string | null = null;
      let acceptNewRuns = false; // Flag to ignore old retained messages

      client.subscribe("axon/runs/latest");

      client.on("message", (topic, message) => {
        const data = JSON.parse(message.toString());

        // 1. Catch the Run ID assigned to our dispatch
        if (topic === "axon/runs/latest" && acceptNewRuns && !activeRunId) {
          activeRunId = data.run_id;
          logger.debug(`[CLI] Assigned Run ID: ${activeRunId}. Waiting for completion...`);
          
          client.unsubscribe("axon/runs/latest");
          client.subscribe(`axon/run/${activeRunId}/status`);
        }

        // 2. Wait for the run to declare completion
        if (activeRunId && topic === `axon/run/${activeRunId}/status`) {
          if (data.status === "completed") {
            const exitCode = data.exitCode || 0;
            
            logger.info(`[CLI] Execution Finished. Result: ${data.success} Success | ${data.skipped} Skipped | ${data.failures} Failed`);
            
            if (data.failures > 0) {
              const failedNames = data.failedServers.map((s: any) => s.name).join(", ");
              logger.error(`[CLI] Failures detected on: ${failedNames}`);
            }

            client.end();
            Deno.exit(exitCode); // Pass the daemon's exit code to the shell
          }
        }
      });

      // Give MQTT 200ms to flush old retained messages before we open our ears and fire
      setTimeout(() => {
        acceptNewRuns = true;
        logger.info(`[CLI] Dispatching '${commandName}' to Axon Engine...`);
        
        client.publish("axon/control/dispatch", JSON.stringify(payload), { qos: 1 }, (err) => {
          if (err) {
            logger.fatal(`[CLI] Failed to publish message: ${err.message}`);
            client.end();
            Deno.exit(1);
          }
        });
      }, 200);

    });

  } catch (error: any) {
    logger.fatal(`[CLI] Execution failed: ${error.message}`);
    Deno.exit(1);
  }
}

await main();