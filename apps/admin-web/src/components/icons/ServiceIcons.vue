<script lang="ts">
import { defineComponent, h } from "vue";

const svg = (paths: string, viewBox = "0 0 24 24") =>
  defineComponent({
    render: () =>
      h("svg", { viewBox, fill: "none", stroke: "currentColor", "stroke-width": "2" }, [
        h("g", { innerHTML: paths }),
      ]),
  });

export const IconAgent = defineComponent({
  render: () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2" }, [
      h("rect", { x: "3", y: "4", width: "18", height: "14", rx: "2" }),
      h("path", { d: "M8 20h8M12 18v2" }),
      h("circle", { cx: "12", cy: "11", r: "2" }),
    ]),
});

export const IconTask = defineComponent({
  render: () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2" }, [
      h("path", { d: "M9 11l3 3L22 4" }),
      h("path", { d: "M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" }),
    ]),
});

export const IconAsr = defineComponent({
  render: () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2" }, [
      h("path", { d: "M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z" }),
      h("path", { d: "M19 10v2a7 7 0 01-14 0v-2" }),
      h("path", { d: "M12 19v3" }),
    ]),
});

export default svg;
</script>
