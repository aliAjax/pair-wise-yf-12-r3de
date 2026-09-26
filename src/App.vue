<script setup lang="ts">
import { ref } from "vue";
import StationsView from "./views/StationsView.vue";
import StoreView from "./views/StoreView.vue";

type PageKey = "stations" | "store";

const pages: { key: PageKey; label: string }[] = [
  { key: "stations", label: "油站网点" },
  { key: "store", label: "便利店批次柜台" }
];
const activePage = ref<PageKey>("store");

const stack = ["Vue3", "Vite", "TypeScript", "localStorage"];
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业前端最小闭环</p>
          <h1>油站网点与便利店批次管理</h1>
          <p class="subtitle">
            维护油站位置、营业状态与库存摘要；便利店按保质期分批登记，销售从最早到期批次扣减，
            过期自动下架，折扣不得低于进价，撤销销售退回原批次，跨站调拨整批移动并预留货位。数据保存在浏览器。
          </p>
        </div>
        <div class="stack">
          <span v-for="item in stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <nav class="page-tabs">
        <button
          v-for="page in pages"
          :key="page.key"
          type="button"
          class="page-tab"
          :class="{ active: activePage === page.key }"
          @click="activePage = page.key"
        >
          {{ page.label }}
        </button>
      </nav>

      <StationsView v-if="activePage === 'stations'" />
      <StoreView v-else />
    </div>
  </main>
</template>
