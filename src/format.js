// Port of internal/zbridge/format.go — OpenAI response/error payload
// builders.
//
// ResponseResult (Go struct) becomes a plain object:
//   { content, text, prompt, finishReason, reasoning }
// (camelCase; Go's Content/Text/Prompt/FinishReason/Reasoning).

import { estimateTokens } from './util.js';

export function formatOpenAIResponse(result, model, requestId, stream) {
    const timestamp = Math.floor(Date.now() / 1000);
    let rawContent = result.content;
    if (!rawContent) rawContent = result.text ?? '';

    if (stream) {
        if (result.finishReason !== 'stop') {
            return {
                id: 'chatcmpl-' + requestId,
                object: 'chat.completion.chunk',
                created: timestamp,
                model,
                choices: [{
                    index: 0,
                    delta: { content: rawContent },
                    finish_reason: null,
                }],
            };
        }
        return {
            id: 'chatcmpl-' + requestId,
            object: 'chat.completion.chunk',
            created: timestamp,
            model,
            choices: [{
                index: 0,
                delta: { content: rawContent },
                finish_reason: 'stop',
            }],
        };
    }

    const promptTokens = estimateTokens(result.prompt ?? '');
    const completionTokens = estimateTokens(rawContent);

    const message = { role: 'assistant', content: rawContent };
    if (result.reasoning) message.reasoning_content = result.reasoning;

    return {
        id: 'chatcmpl-' + requestId,
        object: 'chat.completion',
        created: timestamp,
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: 'stop',
        }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        },
    };
}

export function formatOpenAIError(message, errType, code) {
    return {
        error: {
            message,
            type: errType,
            code: code ?? null,
            param: null,
        },
    };
}
