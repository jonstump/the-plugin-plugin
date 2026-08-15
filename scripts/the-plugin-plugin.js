const MODULE_ID = "the-plugin-plugin";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | initializing`);
});
