<template>
  <div>
    <h2>ASR 识别规则集</h2>
    <div class="card dclip-toolbar">
      <select v-model="selected" @change="loadRuleSet">
        <option v-for="r in ruleSets" :key="String(r.rule_set_id)" :value="r.rule_set_id">
          {{ r.rule_set_id }} (v{{ r.version }})
        </option>
      </select>
    </div>
    <div class="card">
      <h3>规则 JSON 编辑</h3>
      <div class="card-body">
        <textarea v-model="rulesJson" rows="20" />
        <div class="dclip-actions dclip-actions--plain">
          <button class="btn" @click="save">发布新版本</button>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>剧目绑定</h3>
      <table>
        <thead><tr><th>剧目</th><th>当前 RuleSet</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="d in dramas" :key="String(d.dramaId)">
            <td>{{ d.title }}</td>
            <td>{{ d.asrRuleSetId }}</td>
            <td>
              <select @change="bind(String(d.dramaId), ($event.target as HTMLSelectElement).value)">
                <option value="">切换...</option>
                <option v-for="r in ruleSets" :key="String(r.rule_set_id)" :value="r.rule_set_id">{{ r.rule_set_id }}</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!dramas.length">暂无剧目</p>
      <ListPager
        :total="dramaTotal"
        :limit="dramaLimit"
        :offset="dramaOffset"
        @prev="prevDramaPage"
        @next="nextDramaPage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api";
import { PAGE_SIZE } from "../constants/pagination";
import ListPager from "../components/ListPager.vue";

const ruleSets = ref<Record<string, unknown>[]>([]);
const dramas = ref<Record<string, unknown>[]>([]);
const dramaTotal = ref(0);
const dramaLimit = PAGE_SIZE;
const dramaOffset = ref(0);
const selected = ref("drama-default-v1");
const rulesJson = ref("{}");

onMounted(async () => {
  const rs = await api.listRuleSets({ limit: 200, offset: 0 });
  ruleSets.value = rs.ruleSets;
  await Promise.all([loadRuleSet(), loadDramas()]);
});

async function loadDramas() {
  const dr = await api.listDramas({ limit: dramaLimit, offset: dramaOffset.value });
  dramas.value = dr.dramas;
  dramaTotal.value = dr.total;
}

async function loadRuleSet() {
  const rules = await api.getRuleSet(selected.value);
  rulesJson.value = JSON.stringify(rules, null, 2);
}

async function save() {
  const rules = JSON.parse(rulesJson.value);
  await api.updateRuleSet(selected.value, rules);
  alert("RuleSet 已发布新版本");
  const rs = await api.listRuleSets({ limit: 200, offset: 0 });
  ruleSets.value = rs.ruleSets;
}

async function bind(dramaId: string, ruleSetId: string) {
  if (!ruleSetId) return;
  await api.bindDrama(dramaId, ruleSetId);
  await loadDramas();
}

function prevDramaPage() {
  dramaOffset.value = Math.max(0, dramaOffset.value - dramaLimit);
  void loadDramas();
}

function nextDramaPage() {
  dramaOffset.value += dramaLimit;
  void loadDramas();
}
</script>
