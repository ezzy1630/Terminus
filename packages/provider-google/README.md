# @forge/provider-google

Google Gemini renderer. Maps to `generateContent` with `systemInstruction`,
`functionDeclarations`, and `cachedContent`. Same Transport pattern as other
providers.

## Public API

- `GoogleRenderer` — implements `ProviderRenderer`.
- `GoogleTransport` — interface for the HTTP transport.
- `renderRequest(input)` — convenience helper.
- Wire types: `GeminiRequestBody`, `GeminiContent`, `GeminiPart`,
  `GeminiFunctionDeclaration`.

## Invariants

- System fragments go in `systemInstruction`, not in `contents`.
- Tool calls use `functionCall` parts; tool results use `functionResponse` parts.
- `cachedContent` references a previously-created cache resource.
