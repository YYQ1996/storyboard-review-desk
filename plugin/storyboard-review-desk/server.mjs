#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const baseUrl = String(process.env.STORYBOARD_REVIEW_URL || 'http://127.0.0.1:43127').replace(/\/$/, '');

async function callApi(path, body) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`无法连接分镜审核台服务。请先在项目目录运行启动程序，再重试。服务地址：${baseUrl}`);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const issueText = Array.isArray(result.issues) && result.issues.length
      ? `\n${result.issues.map((issue, index) => `${index + 1}. ${issue.name || '未命名图片'}：${issue.reason || '图片无效'}`).join('\n')}`
      : '';
    throw new Error(`${result.error || `分镜审核台返回错误 ${response.status}`}${issueText}`);
  }
  return result;
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

const server = new McpServer({
  name: 'storyboard-review-desk',
  version: '0.1.8',
}, {
  instructions: 'Use these tools only for a run token created by the local Storyboard Review Desk. Always fetch batch context before generating, use only the returned current assets, and submit the final image plus complete standard storyboard text back to the same run token.',
});

server.registerTool('get_batch_context', {
  title: '读取分镜批次',
  description: '使用审核台给出的运行令牌，读取且仅读取该批次的完整结构化分镜、画幅、返修意见和本次选中的人物/场景/道具参考资产绝对路径。生图前必须先调用。',
  inputSchema: {
    token: z.string().min(16).describe('审核台创建任务指令时给出的运行令牌'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ token }) => toolResult((await callApi('/api/mcp/context', { token })).context));

server.registerTool('get_batch_status', {
  title: '查询批次运行状态',
  description: '查询运行令牌对应的当前状态和已经回填的版本；用于提交后确认或故障诊断。',
  inputSchema: {
    token: z.string().min(16).describe('审核台运行令牌'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ token }) => {
  const context = await callApi('/api/mcp/context', { token });
  return toolResult({
    runId: context.context.runId,
    runStatus: context.context.runStatus,
    runMessage: context.context.runMessage,
    resultVersionId: context.context.resultVersionId,
    batchId: context.context.batchId,
    batchName: context.context.batchName,
  });
});

server.registerTool('report_generation_status', {
  title: '回报生图状态',
  description: '在准备参考图、调用内置生图、准备回填或失败时更新审核台状态。完成状态只能由提交版本工具写入。',
  inputSchema: {
    token: z.string().min(16).describe('审核台运行令牌'),
    status: z.enum(['preparing', 'generating', 'submitting', 'failed']).describe('当前阶段'),
    message: z.string().max(1000).optional().describe('简短进度或可重试的失败原因'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ token, status, message }) => toolResult(await callApi('/api/mcp/status', { token, status, message })));

server.registerTool('prepare_revision_script', {
  title: '确认返修分镜脚本',
  description: '返修任务专用。先按审核意见修改完整分镜脚本；允许在本批内合并或新增镜头，审核台会按批次起始镜号自动连续编号。工具校验文本确已变化，返回值中的 imageScript 是随后生图时唯一允许使用的提示词。',
  inputSchema: {
    token: z.string().min(16).describe('本次返修运行令牌'),
    scriptText: z.string().min(10).describe('已经落实全部审核意见的完整标准分镜脚本'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ token, scriptText }) => toolResult(await callApi('/api/mcp/revision-script', { token, scriptText })));

server.registerTool('submit_storyboard_version', {
  title: '回填分镜版本',
  description: '内置图片生成完成后，将生成图片绝对路径和真实宫格布局提交回审核台。审核台自动使用本次已确认的分镜脚本创建下一版本。',
  inputSchema: {
    token: z.string().min(16).describe('本次运行令牌'),
    imagePath: z.string().min(3).describe('Codex 生成图片的绝对文件路径，通常位于 CODEX_HOME/generated_images'),
    scriptText: z.string().min(10).optional().describe('兼容旧调用；新流程无需传入，审核台会使用本次已确认脚本'),
    gridCols: z.number().int().min(1).max(5).describe('宫格实际列数'),
    gridRows: z.number().int().min(1).max(4).describe('宫格实际行数'),
    idempotencyKey: z.string().min(8).describe('本次生成结果的稳定唯一键；重试时必须保持不变'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => toolResult(await callApi('/api/mcp/submit', input)));

const transport = new StdioServerTransport();
await server.connect(transport);
