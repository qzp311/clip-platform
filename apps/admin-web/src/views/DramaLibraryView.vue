<template>
  <TabHub
    v-model="tab"
    title="短剧库"
    description="剧包上传、设备缓存，以及 ASR 识别结果与规则。"
    :tabs="tabs"
  >
    <DramasView v-show="tab === 'upload'" />
    <PackageCacheView v-show="tab === 'cache'" />
    <AsrResultsView v-show="tab === 'results'" />
    <RuleSetsView v-show="tab === 'rules'" />
  </TabHub>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import TabHub from "../components/TabHub.vue";
import DramasView from "./DramasView.vue";
import PackageCacheView from "./PackageCacheView.vue";
import AsrResultsView from "./AsrResultsView.vue";
import RuleSetsView from "./RuleSetsView.vue";

const tabs = [
  { id: "upload", label: "短剧上传", desc: "ZIP 入库开剪" },
  { id: "cache", label: "剧包缓存", desc: "设备本地复用" },
  { id: "results", label: "ASR 结果", desc: "识别记录查询" },
  { id: "rules", label: "ASR 规则", desc: "规则集与绑定" },
];

const TAB_IDS = new Set(tabs.map((t) => t.id));

const route = useRoute();
const router = useRouter();

function tabFromQuery(): string {
  const raw = String(route.query.tab ?? "upload");
  return TAB_IDS.has(raw) ? raw : "upload";
}

const tab = ref(tabFromQuery());

watch(
  () => route.query.tab,
  () => {
    tab.value = tabFromQuery();
  },
);

watch(tab, (id) => {
  if (String(route.query.tab ?? "upload") === id) return;
  void router.replace({ path: "/dramas", query: id === "upload" ? {} : { tab: id } });
});
</script>
