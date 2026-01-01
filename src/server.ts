#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { promisify } from "util";
import { logRun, generateBatchId } from "./logger.js";

const sleep = promisify(setTimeout);

// Safety constants
const OLLAMA_EXECUTABLE = "ollama";
const MAX_PROMPT_LENGTH = 100000;
const MAX_NUM_PREDICT = 8192;
const DEFAULT_TIMEOUT_MS = 120000; // 120s
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;

interface OllamaRunOptions {
  temperature?: number;
  num_predict?: number;
  system?: string;
  timeout?: number;
}

interface OllamaJob {
  model: string;
  prompt: string;
  options?: OllamaRunOptions;
}

interface OllamaResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

// Validate inputs
function validateModel(model: string): void {
  if (!model || typeof model !== "string" || model.trim().length === 0) {
    throw new Error("Model name must be a non-empty string");
  }
  // Prevent command injection
  if (model.includes(";") || model.includes("&") || model.includes("|")) {
    throw new Error("Invalid model name");
  }
}

function validatePrompt(prompt: string): void {
  if (typeof prompt !== "string") {
    throw new Error("Prompt must be a string");
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH}`);
  }
}

function validateOptions(options?: OllamaRunOptions): void {
  if (!options) return;
  
  if (options.num_predict !== undefined) {
    if (typeof options.num_predict !== "number" || options.num_predict < 1 || options.num_predict > MAX_NUM_PREDICT) {
      throw new Error(`num_predict must be between 1 and ${MAX_NUM_PREDICT}`);
    }
  }
  
  if (options.temperature !== undefined) {
    if (typeof options.temperature !== "number" || options.temperature < 0 || options.temperature > 2) {
      throw new Error("temperature must be between 0 and 2");
    }
  }
}

async function ollamaListModels(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(OLLAMA_EXECUTABLE, ["list"]);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Ollama list failed: ${stderr}`));
        return;
      }

      // Parse output: skip header line, extract model names
      const lines = stdout.trim().split("\n");
      const models = lines
        .slice(1) // Skip header
        .map((line) => line.split(/\s+/)[0]) // First column is model name
        .filter((name) => name && name.length > 0);

      resolve(models);
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to execute ollama: ${err.message}`));
    });
  });
}

// Run a single model
async function ollamaRun(
  model: string,
  prompt: string,
  options?: OllamaRunOptions,
  batchId?: string,
  concurrency?: number
): Promise<OllamaResult> {
  validateModel(model);
  validatePrompt(prompt);
  validateOptions(options);

  const timeout = options?.timeout || DEFAULT_TIMEOUT_MS;
  const args = ["run", model];
  
  // Capture start time for logging
  const startTime = new Date().toISOString();
  const startMs = Date.now();

  // Note: ollama CLI doesn't support temperature/num_predict directly via flags
  // These would need to be set via Modelfile or API
  // For now, we just use basic run command
  
  // Prepend system prompt if provided
  let fullPrompt = prompt;
  if (options?.system) {
    fullPrompt = `${options.system}\n\n${prompt}`;
  }

  return new Promise((resolve) => {
    const proc = spawn(OLLAMA_EXECUTABLE, args);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Send prompt via stdin with newline
    proc.stdin.write(fullPrompt + "\n");
    proc.stdin.end();

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle);
      
      // Capture end time and log metrics
      const endTime = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      
      logRun({
        timestamp: startTime,
        model,
        start: startTime,
        end: endTime,
        duration_ms: durationMs,
        exit_code: timedOut ? -1 : (code ?? -1),
        output_chars: stdout.length,
        timed_out: timedOut,
        batch_id: batchId,
        concurrency: concurrency,
      });
      
      if (timedOut) {
        resolve({
          stdout: stdout,
          stderr: stderr + "\nProcess timed out",
          exitCode: -1,
          error: "Timeout exceeded",
        });
      } else {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutHandle);
      
      // Log error case
      const endTime = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      
      logRun({
        timestamp: startTime,
        model,
        start: startTime,
        end: endTime,
        duration_ms: durationMs,
        exit_code: -1,
        output_chars: stdout.length,
        timed_out: false,
        batch_id: batchId,
        concurrency: concurrency,
      });
      
      resolve({
        stdout,
        stderr: stderr + "\n" + err.message,
        exitCode: -1,
        error: err.message,
      });
    });
  });
}

// Run many models concurrently with a limit
async function ollamaRunMany(
  jobs: OllamaJob[],
  maxConcurrency: number = DEFAULT_CONCURRENCY
): Promise<OllamaResult[]> {
  // Validate concurrency
  const concurrency = Math.min(
    Math.max(1, maxConcurrency),
    MAX_CONCURRENCY
  );

  // Validate all jobs first
  for (const job of jobs) {
    validateModel(job.model);
    validatePrompt(job.prompt);
    validateOptions(job.options);
  }

  // Generate batch ID for grouping these runs
  const batchId = generateBatchId();

  const results: OllamaResult[] = new Array(jobs.length);
  const queue = jobs.map((job, index) => ({ job, index }));
  let activeCount = 0;
  let queueIndex = 0;

  return new Promise((resolve) => {
    const processNext = () => {
      if (queueIndex >= queue.length && activeCount === 0) {
        resolve(results);
        return;
      }

      while (activeCount < concurrency && queueIndex < queue.length) {
        const { job, index } = queue[queueIndex];
        queueIndex++;
        activeCount++;

        ollamaRun(job.model, job.prompt, job.options, batchId, concurrency).then((result) => {
          results[index] = result;
          activeCount--;
          processNext();
        });
      }
    };

    processNext();
  });
}

// Create and start MCP server
const server = new Server(
  {
    name: "ollama-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ollama_list_models",
        description: "List all locally available Ollama models",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "ollama_run",
        description: "Run a single Ollama model with a prompt",
        inputSchema: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description: "Name of the Ollama model to run",
            },
            prompt: {
              type: "string",
              description: "Prompt to send to the model",
            },
            options: {
              type: "object",
              description: "Optional parameters for the model",
              properties: {
                temperature: {
                  type: "number",
                  description: "Temperature (0-2)",
                },
                num_predict: {
                  type: "number",
                  description: "Maximum tokens to generate",
                },
                system: {
                  type: "string",
                  description: "System prompt",
                },
                timeout: {
                  type: "number",
                  description: "Timeout in milliseconds (default: 120000)",
                },
              },
            },
          },
          required: ["model", "prompt"],
        },
      },
      {
        name: "ollama_run_many",
        description: "Run multiple Ollama models concurrently with a limit",
        inputSchema: {
          type: "object",
          properties: {
            jobs: {
              type: "array",
              description: "Array of jobs to run",
              items: {
                type: "object",
                properties: {
                  model: {
                    type: "string",
                    description: "Model name",
                  },
                  prompt: {
                    type: "string",
                    description: "Prompt text",
                  },
                  options: {
                    type: "object",
                    description: "Optional parameters",
                    properties: {
                      temperature: { type: "number" },
                      num_predict: { type: "number" },
                      system: { type: "string" },
                      timeout: { type: "number" },
                    },
                  },
                },
                required: ["model", "prompt"],
              },
            },
            maxConcurrency: {
              type: "number",
              description: `Maximum concurrent jobs (default: ${DEFAULT_CONCURRENCY}, max: ${MAX_CONCURRENCY})`,
            },
          },
          required: ["jobs"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "ollama_list_models": {
        const models = await ollamaListModels();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ models }, null, 2),
            },
          ],
        };
      }

      case "ollama_run": {
        const { model, prompt, options } = request.params.arguments as {
          model: string;
          prompt: string;
          options?: OllamaRunOptions;
        };
        
        console.error(`[ollama_run] model=${model}, prompt_length=${prompt.length}`);
        const result = await ollamaRun(model, prompt, options);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "ollama_run_many": {
        const { jobs, maxConcurrency } = request.params.arguments as {
          jobs: OllamaJob[];
          maxConcurrency?: number;
        };
        
        console.error(`[ollama_run_many] jobs=${jobs.length}, concurrency=${maxConcurrency || DEFAULT_CONCURRENCY}`);
        const results = await ollamaRunMany(jobs, maxConcurrency);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ results }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: errorMessage }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ollama MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

