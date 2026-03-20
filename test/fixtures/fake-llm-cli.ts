export {};

const args = process.argv.slice(2);

if (process.env.FAKE_LLM_FAIL === "1") {
  process.stderr.write("fake llm failed\n");
  process.exit(17);
}

const promptIndex = args.indexOf("-p");

if (promptIndex >= 0) {
  const prompt = args[promptIndex + 1] ?? "";
  process.stdout.write(`provider=gemini\n${prompt}`);
  process.exit(0);
}

const stdinText = await new Response(Bun.stdin.stream()).text();
process.stdout.write(`provider=codex\n${stdinText}`);
