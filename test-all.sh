#!/bin/bash

# 清理状态文件
rm -f ~/.openclaw/workspace/tasks/*.json

cd /root/workspace/task-dag-project/task-dag-plugin

echo "=========================================="
echo "Task DAG 完整测试 (v1-v4)"
echo "=========================================="

PASS=0
FAIL=0

run_test() {
    local name="$1"
    local cmd="$2"
    if eval "$cmd" > /dev/null 2>&1; then
        echo "✅ $name"
        ((PASS++))
    else
        echo "❌ $name"
        ((FAIL++))
    fi
}

# ========== DAG Core Tests ==========
echo ""
echo "=== DAG 核心测试 ==="

run_test "createDAG" 'node --input-type=module -e "
import * as dag from '\''./dist/src/dag.js'\'';
const d = dag.createDAG('\''测试'\'', [{id: '\''t1'\'', name: '\''任务1'\''}]);
if (!d.id.startsWith('\''dag-'\'')) throw new Error('\''Failed'\'');
dag.deleteDAG();
"'

run_test "addTask" 'node --input-type=module -e "
import * as dag from '\''./dist/src/dag.js'\'';
dag.createDAG('\''测试'\'', []);
dag.addTask({name: '\''新任务'\'', assigned_agent: '\''scout'\''});
const task = dag.getTask('\''t2'\'');
if (!task) throw new Error('\''Failed'\'');
dag.deleteDAG();
"'

run_test "updateTask" 'node --input-type=module -e "
import * as dag from '\''./dist/src/dag.js'\'';
dag.createDAG('\''测试'\'', [{id: '\''t1'\'', name: '\''任务1'\''}]);
dag.updateTask('\''t1'\'', {status: '\''done'\'', output_summary: '\''完成'\''});
const task = dag.getTask('\''t1'\'');
if (task.status !== '\''done'\'') throw new Error('\''Failed'\'');
dag.deleteDAG();
"'

run_test "getReadyTasks" 'node --input-type=module -e "
import * as dag from '\''./dist/src/dag.js'\'';
dag.createDAG('\''测试'\'', [{id: '\''t1'\'', name: '\''任务1'\''}]);
const ready = dag.getReadyTasks();
if (ready.length !== 1) throw new Error('\''Failed'\'');
dag.deleteDAG();
"'

run_test "getStats" 'node --input-type=module -e "
import * as dag from '\''./dist/src/dag.js'\'';
dag.createDAG('\''测试'\'', [{id: '\''t1'\'', name: '\''任务1'\''}]);
const stats = dag.getStats();
if (stats.total !== 1) throw new Error('\''Failed'\'');
dag.deleteDAG();
"'

run_test "dependency unblock" 'node --input-type=module -e "
import * as dag from '\''./dist/src/dag.js'\'';
dag.createDAG('\''测试'\'', [{id: '\''t1'\'', name: '\''任务1'\''}, {id: '\''t2'\'', name: '\''任务2'\'', dependencies: ['\''t1'\'']}]);
dag.updateTask('\''t1'\'', {status: '\''done'\''});
const ready = dag.getReadyTasks();
if (!ready.some(t => t.id === '\''t2'\'')) throw new Error('\''Failed'\'');
dag.deleteDAG();
"'

# ========== Agent Tests ==========
echo ""
echo "=== Agent 管理测试 ==="

run_test "generateAgentId" 'node --input-type=module -e "
import * as agent from '\''./dist/src/agent.js'\'';
const id = agent.generateAgentId();
if (!id.match(/^agent-\\d+-[a-z0-9]+$/)) throw new Error('\''Failed'\'');
"'

run_test "saveAgentMapping" 'node --input-type=module -e "
import * as agent from '\''./dist/src/agent.js'\'';
agent.saveAgentMapping('\''a1'\'', '\''t1'\'');
if (agent.getAgentByTask('\''t1'\'') !== '\''a1'\'') throw new Error('\''Failed'\'');
"'

run_test "getTaskByAgent" 'node --input-type=module -e "
import * as agent from '\''./dist/src/agent.js'\'';
if (agent.getTaskByAgent('\''a1'\'') !== '\''t1'\'') throw new Error('\''Failed'\'');
"'

run_test "saveSessionMapping" 'node --input-type=module -e "
import * as agent from '\''./dist/src/agent.js'\'';
agent.saveSessionMapping('\''s1'\'', '\''t1'\'', '\''a1'\'');
if (agent.getTaskBySession('\''s1'\'') !== '\''t1'\'') throw new Error('\''Failed'\'');
"'

run_test "removeSessionMapping" 'node --input-type=module -e "
import * as agent from '\''./dist/src/agent.js'\'';
agent.removeSessionMapping('\''s1'\'');
if (agent.getTaskBySession('\''s1'\'') !== null) throw new Error('\''Failed'\'');
"'

# ========== Waiter Tests ==========
echo ""
echo "=== 等待管理测试 ==="

run_test "registerWaiting" 'node --input-type=module -e "
import * as waiter from '\''./dist/src/waiter.js'\'';
waiter.registerWaiting('\''agent1'\'', '\''t1'\'');
if (waiter.getWaitingTask('\''agent1'\'') !== '\''t1'\'') throw new Error('\''Failed'\'');
"'

run_test "unregisterWaiting" 'node --input-type=module -e "
import * as waiter from '\''./dist/src/waiter.js'\'';
waiter.unregisterWaiting('\''agent1'\'');
if (waiter.getWaitingTask('\''agent1'\'') !== null) throw new Error('\''Failed'\'');
"'

run_test "getWaitingAgent" 'node --input-type=module -e "
import * as waiter from '\''./dist/src/waiter.js'\'';
if (waiter.getWaitingAgent('\''t1'\'') !== null) throw new Error('\''Failed'\'');
"'

run_test "isWaiting" 'node --input-type=module -e "
import * as waiter from '\''./dist/src/waiter.js'\'';
waiter.registerWaiting('\''a2'\'', '\''t2'\'');
if (!waiter.isWaiting('\''t2'\'')) throw new Error('\''Failed'\'');
"'

# ========== Notification Tests ==========
echo ""
echo "=== 通知管理测试 ==="

run_test "addNotification" 'node --input-type=module -e "
import * as notif from '\''./dist/src/notification.js'\'';
notif.addNotification('\''t1'\'', {type: '\''progress'\'', message: '\''50%'\'', timestamp: new Date().toISOString(), agent_id: '\''a1'\''});
if (notif.peekNotification('\''t1'\'') === null) throw new Error('\''Failed'\'');
"'

run_test "getAndClearNotification" 'node --input-type=module -e "
import * as notif from '\''./dist/src/notification.js'\'';
const n = notif.getAndClearNotification('\''t1'\'');
if (!n) throw new Error('\''Failed'\'');
"'

run_test "getNotificationCount" 'node --input-type=module -e "
import * as notif from '\''./dist/src/notification.js'\'';
if (notif.getNotificationCount('\''t1'\'') !== 0) throw new Error('\''Failed'\'');
"'

# ========== Hook Tests ==========
echo ""
echo "=== Hook 测试 ==="

run_test "parseTaskLabel task:t1" 'node --input-type=module -e "
import {parseTaskLabel} from '\''./dist/src/hooks.js'\'';
if (parseTaskLabel('\''task:t1'\'') !== '\''t1'\'') throw new Error('\''Failed'\'');
"'

run_test "parseTaskLabel task_id=t1" 'node --input-type=module -e "
import {parseTaskLabel} from '\''./dist/src/hooks.js'\'';
if (parseTaskLabel('\''task_id=t1'\'') !== '\''t1'\'') throw new Error('\''Failed'\'');
"'

run_test "parseTaskLabel t1" 'node --input-type=module -e "
import {parseTaskLabel} from '\''./dist/src/hooks.js'\'';
if (parseTaskLabel('\''t1'\'') !== '\''t1'\'') throw new Error('\''Failed'\'');
"'

run_test "parseTaskLabel invalid" 'node --input-type=module -e "
import {parseTaskLabel} from '\''./dist/src/hooks.js'\'';
if (parseTaskLabel('\''my-agent'\'') !== null) throw new Error('\''Failed'\'');
"'

# ========== Integration Tests ==========
echo ""
echo "=== 集成测试 ==="

run_test "完整流程" 'node --input-type=module -e "
import * as dag from '\''./dist/src/dag.js'\'';
import * as agent from '\''./dist/src/agent.js'\'';
import {parseTaskLabel} from '\''./dist/src/hooks.js'\'';

// 创建
dag.createDAG('\''测试'\'', [{id: '\''t1'\'', name: '\''任务1'\''}]);

// 解析
if (parseTaskLabel('\''task:t1'\'') !== '\''t1'\'') throw new Error('\''Parse failed'\'');

// 映射
agent.saveSessionMapping('\''s1'\'', '\''t1'\'', '\''a1'\'');

// 完成
dag.updateTask('\''t1'\'', {status: '\''done'\''});
if (dag.getTask('\''t1'\'').status !== '\''done'\'') throw new Error('\''Update failed'\'');

// 统计
const stats = dag.getStats();
if (stats.done !== 1) throw new Error('\''Stats failed'\'');
"'

echo ""
echo "=========================================="
echo "结果: $PASS passed, $FAIL failed"
echo "=========================================="

exit $FAIL
