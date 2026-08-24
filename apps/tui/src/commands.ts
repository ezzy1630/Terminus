export interface CommandDefinition {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
}

export const COMMANDS: readonly CommandDefinition[] = [
  { name: "help", usage: "/help", description: "Show keys and commands" },
  { name: "new", usage: "/new", description: "Create and start a task" },
  { name: "refresh", usage: "/refresh", description: "Reload task state" },
  { name: "approve", usage: "/approve", description: "Review the next approval" },
  { name: "answer", usage: "/answer", description: "Answer the next material question" },
  { name: "pause", usage: "/pause", description: "Pause the selected task" },
  { name: "resume", usage: "/resume", description: "Resume the selected task" },
  { name: "review", usage: "/review", description: "Request an independent review" },
  { name: "stop", usage: "/stop", description: "Stop the selected task" },
  { name: "context", usage: "/context <manifest-id>", description: "Inspect a context manifest" },
  { name: "artifact", usage: "/artifact <hash>", description: "Preview an immutable artifact" },
  { name: "job", usage: "/job <id>", description: "Inspect a background job" },
  { name: "stop-job", usage: "/stop-job <id>", description: "Request a controlled job stop" },
  { name: "clear", usage: "/clear", description: "Clear the local transcript view" },
  { name: "quit", usage: "/quit", description: "Exit Terminus" },
];

export function commandSuggestions(input: string): readonly CommandDefinition[] {
  if (!input.startsWith("/")) return [];
  const query = input.slice(1).trimStart().toLowerCase();
  if (query.includes(" ")) return [];
  return COMMANDS.filter((command) => command.name.startsWith(query)).slice(0, 6);
}
