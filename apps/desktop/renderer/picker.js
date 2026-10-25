const grid = document.getElementById("grid");
const cancel = document.getElementById("cancel");

function paint(sources) {
  grid.innerHTML = "";
  for (const src of sources || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "src";
    btn.title = src.name;
    const img = document.createElement("img");
    img.alt = "";
    img.src = src.thumbnailDataUrl || "";
    const label = document.createElement("span");
    label.textContent = src.name;
    btn.append(img, label);
    btn.addEventListener("click", () => {
      window.sfDesktop.pickSource(src.id);
    });
    grid.appendChild(btn);
  }
  if (!sources?.length) {
    const empty = document.createElement("p");
    empty.textContent = "Nenhuma tela ou janela encontrada.";
    grid.appendChild(empty);
  }
}

cancel.addEventListener("click", () => {
  window.sfDesktop.cancelPickSource();
});

window.sfDesktop.getPickerSources().then(paint).catch(() => {
  paint([]);
});
