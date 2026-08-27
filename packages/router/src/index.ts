export {
  RouterError,
  asRouterError,
  type RouterErrorCode,
} from "./errors.js";
export {
  assertModelId,
  assertModelPattern,
  isModelId,
  matchesModelPattern,
  patternSpecificity,
} from "./model.js";
export {
  MAX_ATTEMPTS_DEFAULT,
  MAX_ATTEMPTS_MAX,
  MAX_ATTEMPTS_MIN,
  PRIORITY_DEFAULT,
  PRIORITY_MAX,
  PRIORITY_MIN,
  REQUEST_TIMEOUT_MS_DEFAULT,
  REQUEST_TIMEOUT_MS_MAX,
  REQUEST_TIMEOUT_MS_MIN,
  assertRouteId,
  createRouteRepository,
  parseRouteConfig,
  type CreateRouteInput,
  type CreateRouteRepositoryOptions,
  type RouteConfig,
  type RouteRecord,
  type RouteRepository,
  type UpdateRouteInput,
} from "./repository.js";
export {
  filterFreeCandidates,
  isFreeCandidate,
  resolveCandidates,
  selectRoute,
} from "./selection.js";
export {
  MAX_CONTENT_CHARS,
  MAX_MESSAGES,
  MAX_REQUEST_BYTES,
  MAX_STOP_LENGTH,
  MAX_STOP_SEQUENCES,
  MAX_TOKENS_MAX,
  parseChatRequest,
  type ChatMessage,
  type ChatRequest,
  type ChatRole,
} from "./request.js";
export {
  MAX_CONTENT_BYTES,
  parseChatResponse,
  type ChatResponse,
  type ChatUsage,
} from "./response.js";
export {
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  sendChatRequest,
  sendChatRequestStreaming,
  type SendChatRequestOptions,
  type SendChatRequestStreamingOptions,
  type TransportProvider,
} from "./transport.js";
export {
  parseChatChunk,
  type ChatChunk,
  type ToolCallDelta,
} from "./chunk.js";
export {
  MAX_TOOLS,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_CALLS,
  MAX_TOOL_NAME_LENGTH,
  parseToolCalls,
  parseToolChoice,
  parseToolDefinitions,
  parseToolMessage,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  type ToolMessage,
} from "./tools.js";
export {
  MAX_SSE_LINE_BYTES,
  MAX_SSE_MALFORMED,
  MAX_SSE_TOTAL_BYTES,
  SseLineReader,
  encodeSseDone,
  encodeSseEvent,
} from "./sse.js";
export {
  createRouter,
  type ChatResult,
  type CreateRouterOptions,
  type ChatOptions,
  type RoutedChatChunk,
  type Router,
  type RouterLogger,
  type RouterRecorder,
} from "./router.js";
