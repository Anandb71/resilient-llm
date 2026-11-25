import { ResilientLLM, ResilientLLMError, ProviderRegistry } from '../dist/index.js';
import RateLimitManager from '../dist/lib/RateLimitManager.js';
import CircuitBreaker from '../dist/lib/CircuitBreaker.js';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

use(chaiAsPromised);

describe('OpenAI retirement migration', () => {
    const messages = [{ role: 'user', content: 'What time is it?' }];
    const tools = [{
        type: 'function',
        function: {
            name: 'get_time',
            parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
    }];
    let originalEnv;
    let fetchStub;

    beforeEach(() => {
        originalEnv = process.env;
        process.env = {
            OPENAI_API_KEY: 'test-openai-key',
            ANTHROPIC_API_KEY: 'test-anthropic-key'
        };
        ProviderRegistry.reset();
        for (const provider of ['openai', 'anthropic']) {
            RateLimitManager.clear(provider);
            CircuitBreaker.clear(provider);
        }
        fetchStub = sinon.stub(globalThis, 'fetch').rejects(new Error('Unexpected fetch'));
    });

    afterEach(() => {
        sinon.restore();
        process.env = originalEnv;
        ProviderRegistry.reset();
        for (const provider of ['openai', 'anthropic']) {
            RateLimitManager.clear(provider);
            CircuitBreaker.clear(provider);
        }
    });

    function build(options = {}, overrides = {}) {
        const llm = new ResilientLLM({ aiService: 'openai', model: 'gpt-6-luna', ...options });
        return llm._buildRequest({ conversationHistory: messages, llmOptions: overrides }).requestBody;
    }

    it('selects the documented replacement as the OpenAI fallback', () => {
        expect(ProviderRegistry.getDefaultModels().openai).to.equal('gpt-6-luna');
    });

    for (const withTools of [false, true]) {
        it(`serializes the OpenAI fallback and parses its ${withTools ? 'tool' : 'text'} response`, async () => {
            const toolCalls = [{
                id: 'call_time',
                type: 'function',
                function: { name: 'get_time', arguments: '{}' }
            }];
            fetchStub.onFirstCall().resolves(Response.json({
                error: { message: 'Overloaded' }
            }, { status: 529 }));
            fetchStub.onSecondCall().resolves(Response.json({
                model: 'gpt-6-luna',
                choices: [{
                    message: withTools
                        ? { role: 'assistant', content: null, tool_calls: toolCalls }
                        : { role: 'assistant', content: 'It is noon.' },
                    finish_reason: withTools ? 'tool_calls' : 'stop'
                }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            }));

            const llm = new ResilientLLM({
                aiService: 'anthropic',
                model: 'claude-haiku-4-5-20251001',
                temperature: 0.7,
                topP: 0.8,
                maxTokens: 2048
            });
            const result = await llm.chat(messages, withTools ? { tools } : {});

            sinon.assert.calledTwice(fetchStub);
            const [url, request] = fetchStub.secondCall.args;
            const body = JSON.parse(request.body);
            expect(url).to.equal('https://api.openai.com/v1/chat/completions');
            expect(request.headers.Authorization).to.equal('Bearer test-openai-key');
            expect(body).to.include({ model: 'gpt-6-luna', max_completion_tokens: 2048 });
            expect(body.messages).to.deep.equal(messages);
            for (const field of ['max_tokens', 'temperature', 'top_p']) {
                expect(body).to.not.have.property(field);
            }
            expect(result.metadata.config.model).to.equal('gpt-6-luna');
            expect(result.metadata.service.final).to.equal('openai');
            expect(result.metadata.service.attempted).to.deep.equal(['anthropic', 'openai']);
            if (withTools) {
                expect(body.reasoning_effort).to.equal('none');
                expect(body.tools).to.deep.equal(tools);
                expect(result.content).to.equal(null);
                expect(result.toolCalls).to.deep.equal(toolCalls);
            } else {
                expect(body).to.not.have.property('reasoning_effort');
                expect(result.content).to.equal('It is noon.');
            }
        });
    }

    for (const toolOptions of [{}, { tools: [] }]) {
        it(`keeps the model's default effort with ${toolOptions.tools ? 'empty' : 'no'} tools`, () => {
            const body = build({ temperature: 0.7, topP: 0.8 }, toolOptions);
            for (const field of ['reasoning_effort', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p']) {
                expect(body).to.not.have.property(field);
            }
        });
    }

    const tokenCases = [
        ['constructor maxTokens', { maxTokens: 2048 }, {}, 2048],
        ['per-call maxTokens', { maxTokens: 2048 }, { maxTokens: 512 }, 512],
        ['constructor maxCompletionTokens', { maxTokens: 2048, maxCompletionTokens: 4096 }, { maxTokens: 512 }, 4096],
        ['per-call maxCompletionTokens', { maxCompletionTokens: 4096 }, { maxCompletionTokens: 8192 }, 8192],
        ['environment maxCompletionTokens', {}, {}, 1024]
    ];
    for (const [label, options, overrides, expected] of tokenCases) {
        it(`uses ${label} for the completion budget`, () => {
            if (label.startsWith('environment')) process.env.MAX_COMPLETION_TOKENS = '1024';
            const body = build(options, overrides);
            expect(body.max_completion_tokens).to.equal(expected);
            expect(body).to.not.have.property('max_tokens');
        });
    }

    it('preserves environment and constructor effort for requests without tools', () => {
        process.env.AI_REASONING_EFFORT = 'high';
        expect(build().reasoning_effort).to.equal('high');
        expect(build({ reasoningEffort: 'low' }).reasoning_effort).to.equal('low');
        expect(build({ reasoningEffort: 'low' }, { reasoningEffort: 'max' }).reasoning_effort).to.equal('max');
    });

    it('allows a per-call none effort to override an inherited effort for tools', () => {
        const body = build({ reasoningEffort: 'high' }, { tools, reasoningEffort: 'none' });
        expect(body.reasoning_effort).to.equal('none');
    });

    for (const source of ['environment', 'constructor', 'per-call']) {
        it(`rejects incompatible ${source} effort for tools before sending a request`, async () => {
            if (source === 'environment') process.env.AI_REASONING_EFFORT = 'high';
            const llm = new ResilientLLM({
                aiService: 'openai',
                model: 'gpt-6-luna',
                ...(source === 'constructor' ? { reasoningEffort: 'high' } : {})
            });
            const error = await llm.chat(messages, {
                tools,
                ...(source === 'per-call' ? { reasoningEffort: 'high' } : {})
            }).then(() => { throw new Error('Expected request validation to fail'); }, error => error);
            expect(error).to.be.instanceOf(ResilientLLMError);
            expect(error.code).to.equal('INVALID_REQUEST');
            expect(error.retryable).to.equal(false);
            expect(error.message).to.include('gpt-6-luna').and.include('none');
            sinon.assert.notCalled(fetchStub);
        });
    }

    it('preserves explicit legacy and alternate model overrides', () => {
        for (const model of ['gpt-5-nano', 'gpt-5-nano-2025-08-07', 'gpt-5.6-luna']) {
            const body = build({}, { model, maxTokens: 512, reasoningEffort: 'high' });
            expect(body).to.include({ model, max_completion_tokens: 512, reasoning_effort: 'high' });
            expect(body).to.not.have.property('max_tokens');
        }
    });

    it('preserves sampling for an explicit non-reasoning model', () => {
        const body = build({}, { model: 'gpt-4o-mini', maxTokens: 512, temperature: 0.7, topP: 0.8 });
        expect(body).to.include({ model: 'gpt-4o-mini', max_tokens: 512, temperature: 0.7, top_p: 0.8 });
        expect(body).to.not.have.property('max_completion_tokens');
    });

    it('recognizes prefixed GPT-6 reasoning models without imposing native OpenAI tool settings', () => {
        const body = build({}, {
            aiService: 'openrouter', model: 'openai/gpt-6-luna', apiKey: 'test-openrouter-key',
            tools, maxTokens: 512, reasoningEffort: 'high'
        });
        expect(body).to.include({ max_completion_tokens: 512, reasoning_effort: 'high' });
        expect(body).to.not.have.property('max_tokens');
        expect(build({}, {
            aiService: 'openrouter', model: 'openai/gpt-6-luna', apiKey: 'test-openrouter-key', tools
        })).to.not.have.property('reasoning_effort');
    });

    it('preserves structured output fields and tool continuation messages', () => {
        const history = [
            ...messages,
            { role: 'assistant', content: null, tool_calls: [{
                id: 'call_time', type: 'function', function: { name: 'get_time', arguments: '{}' }
            }] },
            { role: 'tool', tool_call_id: 'call_time', content: 'noon' }
        ];
        const llm = new ResilientLLM({ aiService: 'openai', model: 'gpt-6-luna' });
        const { requestBody } = llm._buildRequest({
            conversationHistory: history,
            llmOptions: { tools, responseFormat: { type: 'json_object' } }
        });
        expect(requestBody.messages).to.deep.equal(history);
        expect(requestBody.response_format).to.deep.equal({ type: 'json_object' });
        expect(requestBody.reasoning_effort).to.equal('none');
    });
});
