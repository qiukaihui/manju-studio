// Only ComfyUI API graphs can be submitted to /prompt; editor JSON is different.
export function normalizeWorkflows(value = {}) {
  const result = {};
  for (const kind of ['image', 'frame', 'video']) {
    const item = value[kind];
    if (!item) { result[kind] = null; continue; }
    const graph = item.graph;
    if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Object.keys(graph).length ||
        Object.values(graph).some((node) => !node || typeof node.class_type !== 'string' ||
          !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs))) {
      throw new Error('请导入 ComfyUI 导出的 API 格式工作流 JSON（不是普通编辑器工作流）');
    }
    const config = { name: String(item.name || `${kind}.json`), graph };
    if (item.bindings) {
      config.bindings = {};
      for (const key of ['prompt', 'negative', 'seed', 'width', 'height', 'seconds', 'frames', 'fps', 'prefix', 'image', 'image2', 'image3', 'image4']) {
        const target = item.bindings[key];
        if (!target) continue;
        if (!Array.isArray(target) || target.length !== 2 || !graph[target[0]] || !Object.hasOwn(graph[target[0]].inputs, target[1]) || Array.isArray(graph[target[0]].inputs[target[1]])) {
          throw new Error(`API 工作流的输入映射无效：${key}`);
        }
        config.bindings[key] = target;
      }
    }
    if (item.outputNode) {
      if (!graph[item.outputNode]) throw new Error('API 工作流输出节点不存在');
      config.outputNode = String(item.outputNode);
    }
    if (kind === 'video' && item.referenceMode === 'cuts') config.referenceMode = 'cuts';
    result[kind] = config;
  }
  return result;
}

export function mergeWorkflowDefaults(defaults, saved = {}) {
  return normalizeWorkflows(Object.fromEntries(['image', 'frame', 'video'].map((kind) =>
    [kind, Object.hasOwn(saved, kind) ? saved[kind] : defaults[kind]])));
}
