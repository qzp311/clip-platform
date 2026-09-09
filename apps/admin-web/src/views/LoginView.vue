<template>
  <div class="dclip-root dclip-login-page">
    <form class="dclip-login-card" @submit.prevent="onSubmit">
      <div class="dclip-login-brand">
        <div class="dclip-brand__mark" aria-hidden="true">
          <img class="dclip-brand__logo" src="/logo.png" width="44" height="44" alt="" />
        </div>
        <div class="dclip-login-brand-text">
          <h2 class="dclip-login-title">drama-clip</h2>
          <p class="dclip-login-subtitle">短剧 AI 智能剪辑平台</p>
        </div>
      </div>
      <p class="dclip-login-subtitle">开源版未启用登录鉴权，直接进入管理台。</p>
      <button class="btn dclip-login-submit" type="submit">进入管理台</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router";

const router = useRouter();

async function onSubmit() {
  await router.replace("/");
}
</script>
