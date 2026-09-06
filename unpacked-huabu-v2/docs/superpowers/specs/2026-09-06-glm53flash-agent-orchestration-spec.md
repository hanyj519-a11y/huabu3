# GLM 5.3 Flash 无限画布 Agent 编排规范

**版本：** 1.0  
**适用对象：** GLM 5.3 Flash（作为画布 Agent 的规划与决策模型）  
**配套对象：** 无限画布 Agent Controller、`__AI2_CANVAS_BRIDGE`、图片/视频/文本节点运行器  
**目标：** 让 Agent 能理解自然语言中的连续任务，按依赖创建节点、建立连线、等待真实结果、基于结果继续操作，并在全部成功后通知用户。

## 1. 设计结论

当前 Agent 的问题不能只靠增加提示词长度解决。模型必须运行在一个“状态驱动的循环编排”中：

```text
读取用户目标和当前画布状态
        ↓
GLM 决定下一步（动作 / 等待 / 澄清 / 完成）
        ↓
前端执行一个决策
        ↓
等待执行结果并重新读取画布状态
        ↓
把真实状态回传给 GLM
        ↺ 直到完成或阻断
```

模型负责：

- 理解用户意图、对象、动作和依赖关系；
- 把“再拉出下游节点”“基于这张图”“旁边加一只猫”等自然语言转换为显式步骤；
- 每轮只选择一个安全的下一步；
- 根据执行器返回的真实状态决定继续、等待、重试、澄清或结束。

执行器负责：

- 生成真实节点 ID，并维护别名到 ID 的映射；
- 建立和校验连线；
- 运行节点并等待终态；
- 确认图片、视频或文本结果真实存在；
- 处理超时、失败、重试和依赖阻断；
- 拒绝非法动作和越权动作。

**硬性原则：模型不能声明执行器没有确认过的事情。**

## 2. GLM 5.3 Flash 系统提示词

下面的内容作为 GLM 5.3 Flash 的系统消息。`{{canvas_state}}`、`{{task_state}}` 和 `{{conversation}}` 由前端在每轮请求前注入。

```text
你是“无限画布 Agent”。你的工作不是聊天，而是把用户对画布的自然语言要求转换成可验证的下一步操作。

一、总目标
1. 理解用户真正想要的结果，以及对象之间的先后依赖。
2. 每轮只输出一个决策：action、wait、clarify 或 finish。
3. 你的决策必须基于当前 canvasState 和 taskState，不能凭空假设节点、图片或运行状态。
4. 前端执行器会执行你的决策，并在下一轮返回新的状态。没有返回结果前，不要假设动作已完成。

二、自然语言理解
1. “生成一只狗”表示创建图片生成节点，提示词为“一只狗”。未指定尺寸、比例、清晰度、模型时，使用画布节点默认值，不要自行发明像素尺寸。
2. “再拉出下游一个节点”“基于这张图”“在新节点上”表示：创建一个新的下游图片节点，建立 source → target 连线，并把 source 的当前主图作为 target 的上游输入。
3. “在狗旁边加一只猫”“保留原图并增加猫”表示：下游提示词必须同时保留源图内容和新增内容，例如“保留原图中的狗，在狗旁边增加一只猫，保持原有主体、构图和风格一致”。
4. “这张图”“刚才生成的图”“上一步结果”优先指向 taskState.aliases 中最近一次成功且有输出的节点；若有多个候选且会改变结果，必须 clarify。
5. 用户明确指定已有节点（如“图片节点1”“节点 abc”）时才允许 updateNode；没有明确指定时创建新节点。
6. 用户没有要求排版、整理、对齐或移动时，禁止输出 layout 或 moveNode。
7. “完成后”“等生成好”“生成成功再继续”是硬依赖，必须先 waitFor 对应节点成功并确认输出存在。

三、动作顺序
1. 先创建上游节点，再运行上游节点。
2. 运行后必须等待节点进入成功或失败终态。
3. 只有在上游 status=success 且 hasOutput=true 时，才可创建依赖它的下游节点。
4. 创建下游节点后，必须先 connect，再 runNode。
5. 下游运行前必须确认 upstreamImages 中包含上游当前主图，不能只依赖 outputImages 历史列表。
6. 任一依赖节点失败或超时，停止所有依赖它的后续步骤；不要伪造成功。
7. finish 只能在 taskState.successCriteria 全部满足后使用。

四、节点引用
1. 新节点必须使用稳定别名，例如 dog、dogCat、finalImage。别名只能由字母、数字、下划线和短横线组成。
2. 连接和运行时使用 alias，不猜真实 ID。执行器负责把 alias 解析为真实 ID。
3. 不要使用含义不明确的“new”引用；如果协议要求引用新节点，使用刚创建动作返回的 alias。
4. 不要重复创建同一目标节点。若 taskState 已有同名 alias，先读取状态，再决定复用还是创建新 alias。

五、输出格式
1. 只输出一个合法 JSON 对象，不要 Markdown 代码围栏，不要额外解释。
2. JSON 顶层必须有 decisionId、type 和 reason。
3. type 只能是 action、wait、clarify、finish。
4. action 每轮只能包含一个动作；不要一次返回动作数组。
5. 当 taskState.phase=planning 时，首次决策必须同时包含 taskPlan。执行器先校验并登记 taskPlan，再执行本轮 action。
6. reason 是给执行器日志使用的一句话，不能宣称尚未验证的结果。

六、不可违反的规则
1. 不得在生成任务仍为 running、queued 或 unknown 时创建依赖该结果的下游节点。
2. 不得把“请求已提交”当作“生成成功”。
3. 不得在没有图片输出时说“已生成图片”。
4. 不得吞掉执行器错误，不得继续执行被失败节点阻断的步骤。
5. 不得擅自修改用户没有提到的模型、比例、尺寸、清晰度、提示词或已有节点。
6. 不得调用 layout、moveNode、deleteNode，除非用户明确要求对应操作。
7. 如果缺少 API、模型、参考图或目标节点，使用 clarify，而不是猜测。

七、终止条件
只有当执行器返回 taskState.successCriteria 全部为 true 时，才输出 finish。finish.message 要清楚说明完成了哪些节点和结果。
``` 

## 3. 循环请求与响应协议

### 3.1 请求上下文

每次调用 GLM 时，前端都提供以下结构化上下文。不要只把画布拼成一段自然语言。

```json
{
  "conversation": [
    {"role": "user", "content": "给我生成一只狗，生成完成后再在下游加一只猫"}
  ],
  "canvasState": {
    "revision": 12,
    "nodes": [],
    "edges": [],
    "selectedNodeAliases": []
  },
  "taskState": {
    "taskId": "task_20260906_001",
    "phase": "planning",
    "aliases": {},
    "steps": [],
    "successCriteria": {
      "dog": false,
      "dogCat": false
    },
    "lastExecution": null
  },
  "capabilities": {
    "nodeTypes": ["generateNode", "videoNode", "textNode"],
    "actions": ["createNode", "updateNode", "connect", "runNode", "waitFor", "inspectNode"]
  }
}
```

### 3.2 模型响应顶层 Schema

```json
{
  "decisionId": "d_003",
  "type": "action | wait | clarify | finish",
  "reason": "一句话说明本轮决策依据",
  "taskPlan": null,
  "action": {},
  "waitFor": {},
  "question": "",
  "message": ""
}
```

字段约束：

- `decisionId` 每轮唯一；执行器用于幂等，重复决策不得重复执行。
- `taskPlan` 只在新任务的首次决策中必填，后续轮次省略或为 `null`。
- `type=action` 时必须有 `action`，且只能有一个动作。
- `type=wait` 时必须有 `waitFor`，不得同时有 `action`。
- `type=clarify` 时必须有一个具体问题，问题应能改变后续动作。
- `type=finish` 时必须有 `message`，且执行器已验证成功条件。

首次决策使用以下 `taskPlan`：

```json
{
  "taskPlan": {
    "goal": "先生成狗，再基于狗图生成狗和猫",
    "steps": [
      {
        "stepId": "step_dog",
        "alias": "dog",
        "intent": "创建并生成一只狗",
        "dependsOn": []
      },
      {
        "stepId": "step_dog_cat",
        "alias": "dogCat",
        "intent": "基于狗图在狗旁边增加一只猫",
        "dependsOn": ["dog"]
      }
    ],
    "successCriteria": [
      {"alias": "dog", "terminalStatus": "success", "requireOutput": true},
      {"alias": "dogCat", "terminalStatus": "success", "requireOutput": true},
      {"edge": {"from": "dog", "to": "dogCat", "inputRole": "image"}}
    ]
  }
}
```

执行器必须拒绝循环依赖、重复 alias、空步骤和不可验证的成功条件。计划登记成功后，`taskState.phase` 从 `planning` 进入 `creating`。

## 4. 动作协议

### 4.1 createNode

```json
{
  "action": {
    "name": "createNode",
    "alias": "dog",
    "nodeType": "generateNode",
    "data": {
      "prompt": "一只狗"
    },
    "position": {"mode": "auto", "relativeTo": null}
  }
}
```

规则：

- `alias` 必须唯一；
- `nodeType=generateNode` 时使用 `prompt`、`model`、`ratio`、`quality`、`count`；
- 未指定的参数由画布节点默认值填充；
- `position.mode=auto` 只表示使用画布的默认新节点位置，不等于执行 layout；
- 创建动作成功后，执行器必须返回 `alias` 和真实 `nodeId`。

### 4.2 updateNode

```json
{
  "action": {
    "name": "updateNode",
    "target": {"alias": "图片节点1"},
    "patch": {"quality": "2k"}
  }
}
```

只有用户明确指定已有节点时才使用。更新后执行器返回新的 `canvasState.revision`。

### 4.3 connect

```json
{
  "action": {
    "name": "connect",
    "from": {"alias": "dog"},
    "to": {"alias": "dogCat"},
    "inputRole": "image"
  }
}
```

执行器必须校验：源节点和目标节点存在、不能自连接、边不存在、源节点类型可以输出图片、目标节点支持图片输入。成功后返回 `edgeId` 和新的 `canvasState.revision`。

### 4.4 runNode

```json
{
  "action": {
    "name": "runNode",
    "target": {"alias": "dog"},
    "retryPolicy": {"maxAttempts": 2}
  }
}
```

`runNode` 只负责启动运行并返回任务句柄；它不能被视为生成成功。执行器必须返回：

```json
{
  "ok": true,
  "runId": "run_dog_001",
  "alias": "dog",
  "status": "queued"
}
```

### 4.5 waitFor

```json
{
  "type": "wait",
  "waitFor": {
    "alias": "dog",
    "terminalStatuses": ["success", "failed"],
    "requireOutput": true,
    "timeoutMs": 600000,
    "pollMs": 1000
  }
}
```

图片节点的 `success` 必须同时满足：

```text
running = false
status = 生成成功 或 success
image 非空
或 outputImages 至少有一项且当前主图已确定
```

等待成功后的执行结果必须包含 `outputRef`：

```json
{
  "ok": true,
  "alias": "dog",
  "status": "success",
  "hasOutput": true,
  "outputRef": {"kind": "image", "sourceAlias": "dog", "selection": "current"}
}
```

### 4.6 inspectNode

```json
{
  "action": {
    "name": "inspectNode",
    "target": {"alias": "dog"},
    "include": ["status", "currentOutput", "upstreamImages", "errors"]
  }
}
```

当状态不确定、执行器返回旧 revision，或模型需要确认当前主图时使用。该动作不改变画布。

## 5. 任务状态机

执行器和模型共同遵循以下状态：

```text
planning
  → creating
  → running
  → waiting
  → succeeded
  → downstream_planning
  → completed
```

失败路径：

```text
creating / running / waiting
  → retrying（最多一次自动重试）
  → failed
  → blocked（所有依赖该节点的步骤）
```

状态转换约束：

1. `creating` 只有在 `createNode.ok=true` 后才能进入下一轮。
2. `running` 不能直接进入 `downstream_planning`。
3. `waiting` 必须收到终态；超时进入 `failed`，不能继续下游。
4. `succeeded` 必须包含输出引用；没有输出则为 `failed`。
5. `completed` 只能由执行器在成功条件全为 true 后开放给模型。

## 6. 狗猫案例：完整逐轮交互

用户输入：

```text
给我生成一只狗，默认尺寸，生成完成后再拉出下游一个节点，再新节点上狗旁边加上一只猫。
```

### 第 1 轮：创建狗节点

```json
{
  "decisionId": "d_001",
  "type": "action",
  "reason": "用户要求先生成狗，尺寸未指定，使用图片节点默认参数。",
  "taskPlan": {
    "goal": "先生成狗，再基于狗图生成狗和猫",
    "steps": [
      {"stepId": "step_dog", "alias": "dog", "intent": "创建并生成一只狗", "dependsOn": []},
      {"stepId": "step_dog_cat", "alias": "dogCat", "intent": "基于狗图在狗旁边增加一只猫", "dependsOn": ["dog"]}
    ],
    "successCriteria": [
      {"alias": "dog", "terminalStatus": "success", "requireOutput": true},
      {"alias": "dogCat", "terminalStatus": "success", "requireOutput": true},
      {"edge": {"from": "dog", "to": "dogCat", "inputRole": "image"}}
    ]
  },
  "action": {
    "name": "createNode",
    "alias": "dog",
    "nodeType": "generateNode",
    "data": {"prompt": "一只狗"},
    "position": {"mode": "auto"}
  }
}
```

执行器返回：

```json
{
  "ok": true,
  "created": {"alias": "dog", "nodeId": "generate-node-abc"},
  "canvasRevision": 13
}
```

### 第 2 轮：运行狗节点

```json
{
  "decisionId": "d_002",
  "type": "action",
  "reason": "狗节点已创建，现在启动上游生成。",
  "action": {
    "name": "runNode",
    "target": {"alias": "dog"},
    "retryPolicy": {"maxAttempts": 2}
  }
}
```

### 第 3 轮：等待狗生成完成

```json
{
  "decisionId": "d_003",
  "type": "wait",
  "reason": "下游节点依赖狗节点的真实图片输出，必须等待终态。",
  "waitFor": {
    "alias": "dog",
    "terminalStatuses": ["success", "failed"],
    "requireOutput": true,
    "timeoutMs": 600000,
    "pollMs": 1000
  }
}
```

执行器返回成功：

```json
{
  "ok": true,
  "alias": "dog",
  "status": "success",
  "hasOutput": true,
  "outputRef": {"kind": "image", "sourceAlias": "dog", "selection": "current"},
  "canvasRevision": 14
}
```

### 第 4 轮：创建下游猫节点

```json
{
  "decisionId": "d_004",
  "type": "action",
  "reason": "狗节点已成功并有当前图片，现在创建用户要求的下游图片节点。",
  "action": {
    "name": "createNode",
    "alias": "dogCat",
    "nodeType": "generateNode",
    "data": {
      "prompt": "保留原图中的狗，在狗旁边增加一只猫，保持原有主体、构图和风格一致"
    },
    "position": {"mode": "downstream", "relativeTo": "dog"}
  }
}
```

### 第 5 轮：连接狗到猫节点

```json
{
  "decisionId": "d_005",
  "type": "action",
  "reason": "下游节点已创建，建立狗图片到下游节点的图片输入连线。",
  "action": {
    "name": "connect",
    "from": {"alias": "dog"},
    "to": {"alias": "dogCat"},
    "inputRole": "image"
  }
}
```

### 第 6 轮：运行下游节点

```json
{
  "decisionId": "d_006",
  "type": "action",
  "reason": "连线已确认，且上游当前主图可用，现在运行下游节点。",
  "action": {
    "name": "runNode",
    "target": {"alias": "dogCat"},
    "retryPolicy": {"maxAttempts": 2}
  }
}
```

### 第 7 轮：等待最终结果

```json
{
  "decisionId": "d_007",
  "type": "wait",
  "reason": "等待下游图片生成完成并确认最终图片输出。",
  "waitFor": {
    "alias": "dogCat",
    "terminalStatuses": ["success", "failed"],
    "requireOutput": true,
    "timeoutMs": 600000,
    "pollMs": 1000
  }
}
```

### 第 8 轮：完成通知

只有执行器返回 `dogCat.status=success`、`dogCat.hasOutput=true`、连线存在后，才允许：

```json
{
  "decisionId": "d_008",
  "type": "finish",
  "reason": "狗节点和下游狗猫节点均已成功并产生图片。",
  "message": "已完成：先生成了狗，再基于狗图创建下游节点并生成了狗旁边有猫的图片。"
}
```

## 7. 澄清、失败和重试规则

### 7.1 必须澄清的情况

只有在缺少的信息会改变结果时才澄清，例如：

- 用户说“修改那张图”，但画布有两张最近图片；
- 用户说“用那个模型”，但有多个模型候选；
- 用户要求“连接到下游”，但没有明确目标且画布存在多个候选节点；
- 用户要求“默认尺寸”，但应用没有配置可读取的默认值。

不应澄清的情况：

- 可以使用节点默认模型、默认比例、默认清晰度；
- “一只狗”这类简单提示词无需追问风格；
- 节点位置可以由 `position.mode=auto` 决定。

### 7.2 失败处理

执行器第一次失败时返回 `retryable=true/false`。只有 `retryable=true` 且尚未重试时，模型才可再次 `runNode`。

第二次失败后：

1. 将节点标记为 `failed`；
2. 把所有依赖该节点的步骤标记为 `blocked`；
3. 禁止继续创建或运行下游；
4. 使用 `clarify` 请求用户决定重试、修改提示词或停止；
5. 不得输出 `finish`。

### 7.3 幂等与重复消息

- 执行器按 `decisionId` 去重；
- 已成功创建 alias 时，重复的相同 `createNode` 返回原结果，不创建第二个节点；
- 已存在相同 source、target、inputRole 的边时，`connect` 返回已存在结果；
- `runNode` 在节点 `running=true` 时返回 `already_running`，模型必须 wait，不得再次提交。

## 8. 前端桥接接口要求

现有 `createNode / updateNode / connect / runNode` 可以保留，但必须在 Agent Controller 外包一层具有以下语义的接口：

```ts
type AgentBridge = {
  getCanvasState(): CanvasState;
  getTaskState(): TaskState;
  createNode(input: CreateNodeInput): Promise<CreateNodeResult>;
  updateNode(input: UpdateNodeInput): Promise<UpdateNodeResult>;
  connect(input: ConnectInput): Promise<ConnectResult>;
  runNode(input: RunNodeInput): Promise<RunNodeResult>;
  waitFor(input: WaitForInput): Promise<WaitForResult>;
  inspectNode(input: InspectNodeInput): Promise<InspectNodeResult>;
};
```

最小 `CanvasState`：

```ts
type CanvasState = {
  revision: number;
  nodes: Array<{
    id: string;
    alias?: string;
    type: string;
    title?: string;
    data: {
      status?: string;
      running?: boolean;
      prompt?: string;
      image?: string;
      outputImages?: string[];
      upstreamImages?: string[];
      error?: string;
    };
    position: { x: number; y: number };
  }>;
  edges: Array<{ id: string; source: string; target: string; inputRole?: string }>;
};
```

执行器必须把 `data.image` 视为生成节点的当前主图，把 `outputImages` 视为历史结果；下游图片输入默认只传当前主图，避免把多次历史结果重复传入。

### 8.1 Agent Controller 主循环

控制器应按以下顺序运行，不能把整个任务交给一次模型响应：

```ts
async function runAgentTask(userMessage: string) {
  const task = createEmptyTask(userMessage);

  for (let turn = 1; turn <= 30; turn += 1) {
    const request = {
      conversation: task.conversation,
      canvasState: bridge.getCanvasState(),
      taskState: task.snapshot(),
      capabilities: bridge.getCapabilities(),
    };

    const decision = await callGlm53Flash(request);
    validateDecision(decision, request);

    if (decision.taskPlan) task.registerPlan(decision.taskPlan);

    if (decision.type === "clarify") {
      return notifyUserAndPause(decision.question);
    }

    if (decision.type === "finish") {
      assertAllSuccessCriteria(task, bridge.getCanvasState());
      return notifyUser(decision.message);
    }

    const execution = decision.type === "wait"
      ? await bridge.waitFor(decision.waitFor)
      : await executeOneAction(bridge, decision.action);

    task.record(decision, execution, bridge.getCanvasState());
  }

  throw new Error("Agent 超过 30 轮仍未完成，任务已暂停，禁止继续自动操作");
}
```

每轮请求都必须使用执行后的最新 `canvasState`。`revision` 未变化不一定代表失败，但创建、更新和连线动作声明成功时必须产生可观察到的状态变化。

### 8.2 决策校验器

`validateDecision` 至少执行以下检查：

- JSON 可解析且只有一个顶层对象；
- `decisionId` 未执行过；
- `type` 与对应字段匹配；
- 首轮存在合法 `taskPlan`；
- alias 已注册或正在本轮合法创建；
- 依赖没有失败、阻断或尚未满足；
- 用户没有要求排版时拒绝 `layout` 和 `moveNode`；
- 上游没有成功输出时拒绝下游 `runNode`；
- `finish` 前重新计算全部成功条件。

### 8.3 模型调用建议

- 使用服务端支持的 JSON 结构化输出模式；若平台只支持普通文本，必须在前端严格解析和校验 JSON，解析失败时只允许请求模型修复格式，不执行任何动作；
- 使用低随机性配置，优先保证动作稳定和字段一致；
- 单任务最多 30 轮，单节点最多运行 2 次；
- 图片和视频等待采用条件轮询，不使用固定睡眠后假定完成；
- 模型请求失败可重试，但模型请求重试不得重复执行已完成的 `decisionId`；
- 保存每轮输入状态摘要、模型决策、执行结果和错误，便于复现误操作。

## 9. 兼容现有一次性 actions 的降级方案

如果暂时不能实现循环调用，至少实现以下兼容层：

1. 支持 `alias` 到真实 ID 的映射，而不是只支持单个 `newId`；
2. `createNode` 返回 `{alias,nodeId}`，后续动作使用 alias；
3. 增加 `waitFor` 动作，并在 `execActions` 中阻塞后续步骤直到终态；
4. 每个动作失败后立即停止依赖它的后续动作；
5. `connect` 校验边是否真的写入；
6. `runNode` 返回 `undefined` 时视为失败，而不是成功；
7. 执行结束后重新生成 canvasState，再向模型请求最终总结。

一次性动作列表只能作为短期兼容模式。复杂任务默认使用循环模式。

## 10. 评测集

每条评测都使用干净画布，并记录模型输出、执行器日志、最终节点图和成功条件。

### A. 单步理解

1. “生成一只狗。”
   - 创建一个 `generateNode`；
   - prompt 包含狗；
   - 未指定参数时保留默认值；
   - 不产生 layout。

2. “生成一只狗，使用 16:9、2K。”
   - ratio=`16:9`；
   - quality=`2k`；
   - 其他参数不被擅自修改。

### B. 顺序与依赖

3. “先生成狗，完成后在下游加猫。”
   - 顺序必须是 create dog → run dog → wait dog → create dogCat → connect → run dogCat → wait dogCat；
   - dog 未成功前不得出现 dogCat。

4. “把刚才那张图接到新节点再生成。”
   - 使用最近成功且有当前主图的节点；
   - 下游只收到当前主图。

### C. 失败处理

5. 上游第一次失败、第二次成功。
   - 最多自动重试一次；
   - 下游只能在第二次成功后继续。

6. 上游两次失败。
   - 下游步骤 blocked；
   - Agent 不得报告完成；
   - 给出可执行的澄清问题。

7. 运行接口返回 queued 且长时间无结果。
   - Agent 必须 wait；
   - 超时后进入失败路径，不能把 queued 当成功。

### D. 引用与歧义

8. 画布中有图片节点1和图片节点2，用户说“修改图片节点1”。
   - 使用 updateNode 指向图片节点1；
   - 不创建新节点。

9. 画布中有两张最近图片，用户说“修改那张图”。
   - clarify，不得猜测。

10. 用户说“整理一下画布”。
    - 只有这类明确表达才允许 layout 或 moveNode。

### E. 完成声明

11. 下游节点已生成但 `image` 为空。
    - 不得 finish；
    - inspectNode 或 waitFor requireOutput=true。

12. 所有成功条件满足。
    - 必须 finish；
    - message 说明实际完成的链路。

## 11. 自动评分指标

建议每条用例按 100 分计算：

| 指标 | 分值 | 判定 |
|---|---:|---|
| 意图解析 | 20 | 节点类型、提示词和用户参数正确 |
| 依赖顺序 | 20 | 上游成功前不创建或运行下游 |
| 等待正确率 | 20 | queued/running 时等待，终态和输出都确认 |
| 节点引用 | 15 | alias、真实 ID、连线方向正确 |
| 失败传播 | 10 | 重试上限正确，失败后下游阻断 |
| 完成声明 | 10 | 仅在成功条件满足后 finish |
| 越权控制 | 5 | 不擅自 layout、移动、改参数或改已有节点 |

发布门槛建议：

- 核心狗猫链路至少 95 分；
- 所有等待正确率必须 100%；
- 失败传播和完成声明不得低于 95%；
- 任何一次“未生成却报告成功”视为严重失败；
- 任何一次上游失败后仍运行下游，视为严重失败。

## 12. 上线顺序

1. 先实现 alias、`waitFor`、`inspectNode` 和严格错误返回；
2. 再把 Agent Controller 改成每轮一个决策；
3. 接入本规范中的系统提示词和结构化上下文；
4. 用评测集验证动作顺序、等待和失败传播；
5. 最后再优化提示词措辞、自然语言覆盖和模型参数；
6. 旧一次性 actions 仅保留为兼容模式，并记录使用次数和失败原因。

## 13. 实施验收标准

当用户输入：

```text
给我生成一只狗，默认尺寸，生成完成后再拉出下游一个节点，再新节点上狗旁边加上一只猫。
```

系统必须满足：

- 自动创建图片节点 A，使用默认尺寸；
- A 生成期间，Agent 不创建依赖 A 的下游节点；
- A 成功且存在当前图片后，创建图片节点 B；
- 自动建立 A → B 的图片连线；
- B 的提示词明确表达“保留狗并在旁边增加猫”；
- B 生成期间 Agent 持续等待；
- B 成功且存在图片后才结束；
- 任一步失败时停止依赖步骤并向用户说明原因；
- 最终消息只在所有成功条件满足后发送。
