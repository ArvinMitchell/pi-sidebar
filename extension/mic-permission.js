document.getElementById("btn").addEventListener("click", async () => {
  const result = document.getElementById("result");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    result.textContent = "✅ 授权成功！可以关闭本页，回到侧边栏点击麦克风使用语音输入。";
    result.className = "ok";
  } catch (err) {
    result.textContent = "❌ 授权失败：" + err.message + "。请点击地址栏左侧的图标，在网站设置中允许麦克风，然后重试。";
    result.className = "fail";
  }
});
