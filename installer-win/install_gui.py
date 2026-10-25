"""
Central de Deploy — interface.

Escolha um dos sistemas, instale ou atualize na VPS, gere o app desktop (Electron)
e publique, e gerencie as versões do app que estão na VPS.
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox

import customtkinter as ctk

import deploy_core as core

BG = "#0a0f1c"
SIDEBAR = "#0d1424"
CARD = "#121a2c"
CARD_HOVER = "#172238"
INPUT = "#0e1627"
BORDER = "#22304a"
TEXT = "#e7ecf7"
MUTED = "#8a97b1"
FAINT = "#56647f"
SUCCESS = "#34d399"
WARN = "#fbbf24"
DANGER = "#f87171"
DEFAULT_ACCENT = "#5bc4e9"

STEP_ICONS = {
    "idle": ("○", FAINT),
    "run": ("●", None),  # usa a cor do sistema
    "ok": ("✓", SUCCESS),
    "fail": ("✕", DANGER),
    "skip": ("–", MUTED),
}


def shade(hex_color: str, factor: float) -> str:
    hex_color = hex_color.lstrip("#")
    r, g, b = (int(hex_color[i : i + 2], 16) for i in (0, 2, 4))
    r, g, b = (max(0, min(255, int(c * factor))) for c in (r, g, b))
    return f"#{r:02x}{g:02x}{b:02x}"


class Cancelled(Exception):
    pass


class DeployCenter(ctk.CTk):
    def __init__(self) -> None:
        ctk.set_appearance_mode("dark")
        super().__init__()
        self.title("Central de Deploy · Castino")
        self.geometry("1280x820")
        self.minsize(1180, 720)
        self.configure(fg_color=BG)

        self.cfg = core.load_config()
        self.q: queue.Queue = queue.Queue()
        self.busy = False
        self.profile: core.SystemProfile | None = None
        self.repo: Path | None = None
        self.accent = DEFAULT_ACCENT
        self.accent_buttons: list[ctk.CTkButton] = []
        self.action_buttons: list[ctk.CTkButton] = []
        self.feed_data: dict | None = None
        self.overview: dict | None = None
        self.conn_state = "idle"
        self._fonts: dict[tuple, ctk.CTkFont] = {}

        self._build_start()
        self._build_main()
        self._show_start()
        self.after(60, self._drain)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ helpers de UI

    def font(self, size: int, bold: bool = False, family: str = "Segoe UI") -> ctk.CTkFont:
        key = (family, size, bold)
        if key not in self._fonts:
            self._fonts[key] = ctk.CTkFont(
                family=family, size=size, weight="bold" if bold else "normal"
            )
        return self._fonts[key]

    def card(self, parent, **kw) -> ctk.CTkFrame:
        return ctk.CTkFrame(
            parent,
            fg_color=kw.pop("fg_color", CARD),
            corner_radius=kw.pop("corner_radius", 14),
            border_width=1,
            border_color=BORDER,
            **kw,
        )

    def label(self, parent, text="", size=13, bold=False, color=TEXT, **kw) -> ctk.CTkLabel:
        return ctk.CTkLabel(
            parent,
            text=text,
            font=self.font(size, bold),
            text_color=color,
            anchor=kw.pop("anchor", "w"),
            justify=kw.pop("justify", "left"),
            **kw,
        )

    def entry(self, parent, placeholder="", show=None, width=140) -> ctk.CTkEntry:
        return ctk.CTkEntry(
            parent,
            placeholder_text=placeholder,
            show=show,
            width=width,
            height=38,
            corner_radius=10,
            border_width=1,
            border_color=BORDER,
            fg_color=INPUT,
            text_color=TEXT,
            placeholder_text_color=FAINT,
            font=self.font(13),
        )

    @staticmethod
    def set_entry(widget: ctk.CTkEntry, value: str) -> None:
        # get() devolve "" com o placeholder ativo; apagar nesse estado some com o placeholder
        if widget.get():
            widget.delete(0, "end")
        if value:
            widget.insert(0, value)

    def field(self, parent, title: str, widget_factory, hint: str = "") -> tuple[ctk.CTkFrame, ctk.CTkEntry]:
        box = ctk.CTkFrame(parent, fg_color="transparent")
        self.label(box, title, 12, color=MUTED).pack(fill="x", pady=(0, 4))
        widget = widget_factory(box)
        widget.pack(fill="x")
        if hint:
            self.label(box, hint, 11, color=FAINT, wraplength=520).pack(fill="x", pady=(3, 0))
        return box, widget

    def primary_button(self, parent, text, command, width=180, action=True) -> ctk.CTkButton:
        btn = ctk.CTkButton(
            parent,
            text=text,
            command=command,
            width=width,
            height=42,
            corner_radius=11,
            fg_color=self.accent,
            hover_color=shade(self.accent, 0.82),
            text_color="#08111f",
            text_color_disabled="#3b4a63",
            font=self.font(13, True),
        )
        self.accent_buttons.append(btn)
        if action:
            self.action_buttons.append(btn)
        return btn

    def ghost_button(self, parent, text, command, width=140, height=38, action=True, danger=False) -> ctk.CTkButton:
        btn = ctk.CTkButton(
            parent,
            text=text,
            command=command,
            width=width,
            height=height,
            corner_radius=10,
            fg_color="transparent",
            hover_color="#3a1d24" if danger else CARD_HOVER,
            border_width=1,
            border_color="#5b2a33" if danger else BORDER,
            text_color=DANGER if danger else TEXT,
            text_color_disabled=FAINT,
            font=self.font(12, True),
        )
        if action:
            self.action_buttons.append(btn)
        return btn

    def chip(self, parent, text, color=MUTED) -> ctk.CTkLabel:
        return ctk.CTkLabel(
            parent,
            text=f"  {text}  ",
            font=self.font(11, True),
            text_color=color,
            fg_color=INPUT,
            corner_radius=8,
            height=24,
        )

    def _set_accent(self, color: str) -> None:
        self.accent = color
        alive = []
        for btn in self.accent_buttons:
            try:
                btn.configure(fg_color=color, hover_color=shade(color, 0.82))
                alive.append(btn)
            except tk.TclError:
                pass
        self.accent_buttons = alive
        self.progress.configure(progress_color=color)
        self.sys_dot.configure(fg_color=color)
        for name, btn in self.nav_buttons.items():
            if name == getattr(self, "current_page", ""):
                btn.configure(text_color=color)

    # ------------------------------------------------------------------ tela inicial

    def _build_start(self) -> None:
        view = self.start_view = ctk.CTkScrollableFrame(self, fg_color=BG, corner_radius=0)
        inner = ctk.CTkFrame(view, fg_color="transparent")
        inner.pack(fill="both", expand=True, padx=48, pady=(34, 24))

        self.label(inner, "CASTINO  ·  CENTRAL DE DEPLOY", 12, True, DEFAULT_ACCENT).pack(fill="x")
        self.label(inner, "Qual sistema você quer gerenciar?", 30, True).pack(fill="x", pady=(6, 2))
        self.label(
            inner,
            "Instale ou atualize na VPS, gere o app desktop e controle as versões publicadas.",
            14,
            color=MUTED,
        ).pack(fill="x", pady=(0, 18))

        conn = self.card(inner)
        conn.pack(fill="x", pady=(0, 14), padx=8)
        head = ctk.CTkFrame(conn, fg_color="transparent")
        head.pack(fill="x", padx=22, pady=(18, 4))
        self.label(head, "Conexão com a VPS", 17, True).pack(side="left")
        self.conn_badge = self.chip(head, "não testada")
        self.conn_badge.pack(side="left", padx=12)
        self.label(
            conn,
            "Ao conectar, os cards abaixo mostram o que está instalado e rodando. A senha fica só na memória.",
            12,
            color=MUTED,
        ).pack(fill="x", padx=22)

        row = ctk.CTkFrame(conn, fg_color="transparent")
        row.pack(fill="x", padx=22, pady=(14, 6))
        row.grid_columnconfigure(0, weight=3)
        row.grid_columnconfigure(1, weight=1)
        row.grid_columnconfigure(2, weight=1)
        row.grid_columnconfigure(3, weight=2)
        b, self.e_host = self.field(row, "IP ou hostname", lambda p: self.entry(p, "vps.example.com"))
        b.grid(row=0, column=0, sticky="ew", padx=(0, 10))
        b, self.e_user = self.field(row, "Usuário", lambda p: self.entry(p, "root"))
        b.grid(row=0, column=1, sticky="ew", padx=(0, 10))
        b, self.e_sshport = self.field(row, "Porta SSH", lambda p: self.entry(p, "22"))
        b.grid(row=0, column=2, sticky="ew", padx=(0, 10))
        b, self.e_pass = self.field(row, "Senha", lambda p: self.entry(p, "senha root", show="•"))
        b.grid(row=0, column=3, sticky="ew", padx=(0, 10))
        test = self.primary_button(row, "Conectar", self._test_connection, width=150)
        test.grid(row=0, column=4, sticky="s")

        self.set_entry(self.e_host, self.cfg.get("host", ""))
        self.set_entry(self.e_user, self.cfg.get("user", "root"))
        self.set_entry(self.e_sshport, str(self.cfg.get("ssh_port", 22)))
        self.set_entry(self.e_pass, core.saved_password())

        self.conn_detail = self.label(conn, "", 12, color=MUTED)
        self.conn_detail.pack(fill="x", padx=22, pady=(4, 0))
        self.infra_row = ctk.CTkFrame(conn, fg_color="transparent")
        self.infra_row.pack(fill="x", padx=22, pady=(6, 18))

        grid = ctk.CTkFrame(inner, fg_color="transparent")
        grid.pack(fill="x")
        for col in range(3):
            grid.grid_columnconfigure(col, weight=1, uniform="cards")
        self.system_cards: dict[str, dict] = {}
        for idx, prof in enumerate(core.PROFILES):
            self._system_card(grid, prof).grid(
                row=idx // 3, column=idx % 3, sticky="nsew", padx=8, pady=8
            )

        ws = ctk.CTkFrame(inner, fg_color="transparent")
        ws.pack(fill="x", padx=8, pady=(16, 0))
        self.ws_label = self.label(ws, "", 12, color=MUTED)
        self.ws_label.pack(side="left")
        self.ghost_button(ws, "Alterar pasta dos projetos", self._pick_workspace, width=200, height=32, action=False).pack(side="right")
        self._refresh_cards()

    def _system_card(self, parent, prof: core.SystemProfile) -> ctk.CTkFrame:
        card = self.card(parent, corner_radius=16)
        bar = ctk.CTkFrame(card, fg_color=prof.accent, height=4, corner_radius=2)
        bar.pack(fill="x", padx=18, pady=(14, 0))

        top = ctk.CTkFrame(card, fg_color="transparent")
        top.pack(fill="x", padx=18, pady=(12, 0))
        self.label(top, prof.name, 17, True).pack(side="left")
        self.label(card, prof.tagline, 12, color=MUTED).pack(fill="x", padx=18, pady=(2, 10))

        chips = ctk.CTkFrame(card, fg_color="transparent")
        chips.pack(fill="x", padx=18)
        self.chip(chips, prof.stack).pack(side="left", padx=(0, 6))
        if prof.desktop:
            self.chip(chips, "App desktop", prof.accent).pack(side="left", padx=(0, 6))
        self.chip(chips, f":{prof.default_port}").pack(side="left")

        live = ctk.CTkFrame(card, fg_color=INPUT, corner_radius=10)
        live.pack(fill="x", padx=18, pady=(12, 0))
        live_state = self.label(live, "○  Conecte na VPS para ver o estado", 12, True, FAINT)
        live_state.pack(fill="x", padx=12, pady=(8, 0))
        live_detail = self.label(live, "", 11, color=MUTED, wraplength=300)
        live_detail.pack(fill="x", padx=12, pady=(0, 8))

        status = self.label(card, "", 11, color=MUTED, wraplength=300)
        status.pack(fill="x", padx=18, pady=(10, 0))

        foot = ctk.CTkFrame(card, fg_color="transparent")
        foot.pack(fill="x", padx=18, pady=(10, 16))
        open_btn = ctk.CTkButton(
            foot,
            text="Abrir",
            width=90,
            height=32,
            corner_radius=9,
            fg_color=prof.accent,
            hover_color=shade(prof.accent, 0.82),
            text_color="#08111f",
            font=self.font(12, True),
            command=lambda p=prof: self._open_system(p),
        )
        open_btn.pack(side="left")
        self.ghost_button(
            foot, "Pasta…", lambda p=prof: self._pick_repo(p), width=80, height=32, action=False
        ).pack(side="left", padx=8)

        def enter(_e=None) -> None:
            card.configure(border_color=prof.accent, fg_color=CARD_HOVER)

        def leave(_e=None) -> None:
            def check() -> None:
                x, y = card.winfo_pointerxy()
                w = card.winfo_containing(x, y)
                while w is not None and w is not card:
                    w = getattr(w, "master", None)
                if w is None:
                    card.configure(border_color=BORDER, fg_color=CARD)

            card.after(15, check)

        def bind_all(widget) -> None:
            if isinstance(widget, ctk.CTkButton):
                return
            widget.bind("<Enter>", enter, add="+")
            widget.bind("<Leave>", leave, add="+")
            widget.bind("<Button-1>", lambda _e, p=prof: self._open_system(p), add="+")
            for child in widget.winfo_children():
                bind_all(child)

        bind_all(card)
        self.system_cards[prof.key] = {"status": status, "state": live_state, "detail": live_detail}
        return card

    def _refresh_cards(self) -> None:
        self.ws_label.configure(
            text=f"Pasta dos projetos: {self.cfg.get('workspace') or core.default_workspace()}"
        )
        for prof in core.PROFILES:
            repo = core.repo_path(prof, self.cfg)
            status = self.system_cards[prof.key]["status"]
            if core.repo_ok(prof, repo):
                status.configure(text=f"●  {repo}", text_color=SUCCESS)
            else:
                status.configure(text=f"●  Pasta não encontrada: {repo}", text_color=DANGER)

    def _pick_workspace(self) -> None:
        path = filedialog.askdirectory(title="Pasta que contém os projetos")
        if path:
            self.cfg["workspace"] = path
            core.save_config(self.cfg)
            self._refresh_cards()

    def _pick_repo(self, prof: core.SystemProfile) -> bool:
        path = filedialog.askdirectory(title=f"Pasta do projeto {prof.name}")
        if not path:
            return False
        if not core.repo_ok(prof, Path(path)):
            messagebox.showerror(
                "Pasta inválida", f"Não achei {prof.bootstrap} em:\n{path}"
            )
            return False
        self.cfg.setdefault("paths", {})[prof.key] = path
        core.save_config(self.cfg)
        self._refresh_cards()
        return True

    def _show_start(self) -> None:
        self.main_view.pack_forget()
        self.start_view.pack(fill="both", expand=True)
        self.title("Central de Deploy · Castino")

    # ------------------------------------------------------------------ tela principal

    def _build_main(self) -> None:
        view = self.main_view = ctk.CTkFrame(self, fg_color=BG, corner_radius=0)

        side = ctk.CTkFrame(view, fg_color=SIDEBAR, corner_radius=0, width=224)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)
        self.label(side, "CENTRAL DE DEPLOY", 11, True, FAINT).pack(fill="x", padx=22, pady=(24, 14))

        sysrow = ctk.CTkFrame(side, fg_color="transparent")
        sysrow.pack(fill="x", padx=22)
        self.sys_dot = ctk.CTkFrame(sysrow, width=12, height=12, corner_radius=6, fg_color=self.accent)
        self.sys_dot.pack(side="left", pady=(4, 0))
        self.sys_name = self.label(sysrow, "", 17, True, wraplength=170)
        self.sys_name.pack(side="left", padx=(10, 0))
        self.sys_tag = self.label(side, "", 12, color=MUTED, wraplength=180)
        self.sys_tag.pack(fill="x", padx=22, pady=(4, 0))
        self.sys_repo = self.label(side, "", 10, color=FAINT, wraplength=180)
        self.sys_repo.pack(fill="x", padx=22, pady=(6, 12))
        self.ghost_button(side, "⇄  Trocar sistema", self._back_to_start, width=180, height=34).pack(padx=22)

        ctk.CTkFrame(side, height=1, fg_color=BORDER).pack(fill="x", padx=22, pady=18)

        self.nav_buttons: dict[str, ctk.CTkButton] = {}
        for key, text in (
            ("server", "🖥   Servidor"),
            ("desktop", "📦   App desktop"),
            ("versions", "🗂   Versões na VPS"),
        ):
            btn = ctk.CTkButton(
                side,
                text=text,
                anchor="w",
                width=180,
                height=40,
                corner_radius=10,
                fg_color="transparent",
                hover_color=CARD_HOVER,
                text_color=TEXT,
                text_color_disabled=FAINT,
                font=self.font(13, True),
                command=lambda k=key: self._show_page(k),
            )
            btn.pack(padx=22, pady=2)
            self.nav_buttons[key] = btn
        self.nav_note = self.label(side, "", 11, color=FAINT, wraplength=180)
        self.nav_note.pack(fill="x", padx=26, pady=(4, 0))

        vps = ctk.CTkFrame(side, fg_color=CARD, corner_radius=12)
        vps.pack(side="bottom", fill="x", padx=16, pady=18)
        self.label(vps, "VPS", 11, True, FAINT).pack(fill="x", padx=14, pady=(10, 0))
        self.side_vps = self.label(vps, "", 12, wraplength=170)
        self.side_vps.pack(fill="x", padx=14)
        self.side_vps_state = self.label(vps, "", 11, color=MUTED)
        self.side_vps_state.pack(fill="x", padx=14, pady=(0, 10))

        content = ctk.CTkFrame(view, fg_color=BG, corner_radius=0)
        content.pack(side="left", fill="both", expand=True)
        content.grid_columnconfigure(0, weight=1)
        content.grid_columnconfigure(1, weight=0, minsize=340)
        content.grid_rowconfigure(1, weight=1)

        header = ctk.CTkFrame(content, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", padx=(28, 14), pady=(24, 10))
        self.page_title = self.label(header, "", 24, True)
        self.page_title.pack(fill="x")
        self.page_sub = self.label(header, "", 13, color=MUTED, wraplength=620)
        self.page_sub.pack(fill="x", pady=(2, 0))

        self.pages_host = ctk.CTkFrame(content, fg_color="transparent")
        self.pages_host.grid(row=1, column=0, sticky="nsew", padx=(20, 8), pady=(0, 20))
        self.wrapped: list[ctk.CTkLabel] = []
        self.pages_host.bind("<Configure>", self._rewrap, add="+")

        self._build_activity(content)

        self.pages: dict[str, ctk.CTkScrollableFrame] = {}
        self._build_server_page()
        self._build_desktop_page()
        self._build_versions_page()

    def wrap(self, lbl: ctk.CTkLabel) -> ctk.CTkLabel:
        self.wrapped.append(lbl)
        return lbl

    def _rewrap(self, event) -> None:
        width = max(300, event.width - 90)
        for lbl in self.wrapped:
            lbl.configure(wraplength=width)
        self.page_sub.configure(wraplength=width)

    def _page(self, key: str) -> ctk.CTkScrollableFrame:
        page = ctk.CTkScrollableFrame(
            self.pages_host,
            fg_color="transparent",
            corner_radius=0,
            scrollbar_button_color=CARD,
            scrollbar_button_hover_color=BORDER,
        )
        self.pages[key] = page
        return page

    def _build_activity(self, parent) -> None:
        panel = self.card(parent, width=320)
        panel.grid(row=0, column=1, rowspan=2, sticky="ns", padx=(8, 22), pady=22)
        panel.pack_propagate(False)
        top = ctk.CTkFrame(panel, fg_color="transparent")
        top.pack(fill="x", padx=18, pady=(16, 0))
        self.label(top, "Atividade", 15, True).pack(side="left")
        self.ghost_button(top, "Limpar", self._clear_log, width=70, height=28, action=False).pack(side="right")
        self.ghost_button(top, "Copiar", self._copy_log, width=70, height=28, action=False).pack(side="right", padx=6)

        status = ctk.CTkFrame(panel, fg_color="transparent")
        status.pack(fill="x", padx=18, pady=(12, 0))
        self.status_lbl = self.label(status, "Pronto", 12, wraplength=330)
        self.status_lbl.pack(side="left", fill="x", expand=True)
        self.pct_lbl = self.label(status, "", 12, True, MUTED)
        self.pct_lbl.pack(side="right")
        self.progress = ctk.CTkProgressBar(
            panel, height=8, corner_radius=4, fg_color=INPUT, progress_color=self.accent
        )
        self.progress.pack(fill="x", padx=18, pady=(8, 12))
        self.progress.set(0)

        self.log = ctk.CTkTextbox(
            panel,
            fg_color=INPUT,
            text_color="#c9d3e6",
            border_width=0,
            corner_radius=10,
            font=ctk.CTkFont(family="Consolas", size=11),
            wrap="word",
        )
        self.log.pack(fill="both", expand=True, padx=12, pady=(0, 12))
        self.log.tag_config("time", foreground=FAINT)
        self.log.tag_config("err", foreground=DANGER)
        self.log.tag_config("ok", foreground=SUCCESS)
        self.log.tag_config("head", foreground=DEFAULT_ACCENT)
        self.log.configure(state="disabled")

    # ------------------------------------------------------------------ página: servidor

    def _build_server_page(self) -> None:
        page = self._page("server")

        self.mode_seg = ctk.CTkSegmentedButton(
            page,
            values=["Atualizar código", "Instalar do zero"],
            command=lambda _v: self._layout_server(),
            height=38,
            corner_radius=10,
            font=self.font(13, True),
            fg_color=INPUT,
            unselected_color=INPUT,
            unselected_hover_color=CARD_HOVER,
            selected_color=CARD_HOVER,
            selected_hover_color=CARD_HOVER,
            text_color=TEXT,
        )
        self.mode_seg.pack(fill="x", pady=(4, 14))
        self.mode_seg.set("Atualizar código")

        info = self.card(page)
        info.pack(fill="x", pady=(0, 12))
        grid = ctk.CTkFrame(info, fg_color="transparent")
        grid.pack(fill="x", padx=20, pady=16)
        grid.grid_columnconfigure((0, 1), weight=1)
        self.info_vals: dict[str, ctk.CTkLabel] = {}
        for i, (key, title) in enumerate(
            (
                ("dest", "Destino na VPS"),
                ("service", "Serviço systemd"),
                ("status", "Situação"),
                ("deploy", "Último deploy"),
                ("port", "Porta local"),
                ("url", "Endereço"),
            )
        ):
            cell = ctk.CTkFrame(grid, fg_color="transparent")
            cell.grid(row=i // 2, column=i % 2, sticky="ew", pady=4)
            self.label(cell, title, 11, color=FAINT).pack(fill="x")
            val = self.label(cell, "—", 13, True, wraplength=260)
            val.pack(fill="x")
            self.info_vals[key] = val

        self.mode_desc = self.card(page)
        self.mode_desc.pack(fill="x", pady=(0, 12))
        self.mode_desc_lbl = self.wrap(self.label(self.mode_desc, "", 13, color=MUTED))
        self.mode_desc_lbl.pack(fill="x", padx=20, pady=16)

        self.site_card = self.card(page)
        body = ctk.CTkFrame(self.site_card, fg_color="transparent")
        body.pack(fill="x", padx=20, pady=16)
        self.row_domain, self.e_domain = self.field(
            body, "Domínio (DNS A apontando para a VPS)", lambda p: self.entry(p, "")
        )
        self.row_public, self.e_public = self.field(
            body,
            "Domínio público da fila e da agenda",
            lambda p: self.entry(p, ""),
            "Os clientes abrem a fila e a agenda neste endereço. O painel continua no domínio de cima.",
        )
        self.row_port, self.e_port = self.field(body, "Porta local na VPS", lambda p: self.entry(p, ""))
        self.ssl_var = tk.BooleanVar(value=True)
        self.row_ssl = ctk.CTkSwitch(
            body,
            text="Ativar HTTPS com Let's Encrypt",
            variable=self.ssl_var,
            command=self._layout_server,
            font=self.font(13),
            text_color=TEXT,
            progress_color=self.accent,
        )
        self.row_email, self.e_email = self.field(body, "E-mail do Let's Encrypt", lambda p: self.entry(p, "admin@seudominio.com"))
        self.set_entry(self.e_email, self.cfg.get("ssl_email", ""))
        self.row_options = ctk.CTkFrame(body, fg_color="transparent")
        self.option_vars: dict[str, tk.BooleanVar] = {}

        actions = ctk.CTkFrame(page, fg_color="transparent")
        actions.pack(fill="x", pady=(4, 8))
        self.deploy_btn = self.primary_button(actions, "Atualizar agora", self._start_deploy, width=200)
        self.deploy_btn.pack(side="left")
        self.ghost_button(actions, "Verificar serviço", self._check_service, width=150, height=42).pack(side="left", padx=10)
        self.server_actions = actions

        hist = self.card(page)
        hist.pack(fill="x", pady=(8, 12))
        self.label(hist, "Histórico na VPS", 14, True).pack(fill="x", padx=20, pady=(14, 0))
        self.wrap(
            self.label(
                hist,
                "Operações feitas pela Central (a partir de agora). Deploys anteriores aparecem só como data estimada.",
                11,
                color=FAINT,
            )
        ).pack(fill="x", padx=20)
        self.history_host = ctk.CTkFrame(hist, fg_color="transparent")
        self.history_host.pack(fill="x", padx=14, pady=(8, 12))

    def _layout_server(self) -> None:
        p = self.profile
        if not p:
            return
        install = self.mode_seg.get() == "Instalar do zero"
        self.mode_desc_lbl.configure(text=p.install_desc if install else p.update_desc)
        self.deploy_btn.configure(text="Instalar agora" if install else "Atualizar agora")
        needs_site = install or not p.update_keeps_nginx
        for w in (self.row_domain, self.row_public, self.row_port, self.row_ssl, self.row_email, self.row_options):
            w.pack_forget()
        shows_public = bool(p.public_domain_hint)
        if needs_site or shows_public:
            self.site_card.pack(fill="x", pady=(0, 12), before=self.server_actions)
            self.row_domain.pack(fill="x", pady=(0, 10))
            if shows_public:
                self.row_public.pack(fill="x", pady=(0, 10))
            if install:
                self.row_port.pack(fill="x", pady=(0, 10))
            self.row_ssl.pack(fill="x", pady=(2, 10))
            if self.ssl_var.get():
                self.row_email.pack(fill="x", pady=(0, 10))
            if install and p.options:
                self.row_options.pack(fill="x", pady=(4, 0))
        else:
            self.site_card.pack_forget()

    # ------------------------------------------------------------------ página: app desktop

    def _build_desktop_page(self) -> None:
        page = self._page("desktop")

        tiles = ctk.CTkFrame(page, fg_color="transparent")
        tiles.pack(fill="x", pady=(4, 12))
        tiles.grid_columnconfigure((0, 1, 2), weight=1, uniform="tiles")
        self.tiles: dict[str, tuple[ctk.CTkLabel, ctk.CTkLabel]] = {}
        for i, (key, title) in enumerate(
            (("code", "Versão no código"), ("build", "Último build local"), ("live", "Padrão na VPS"))
        ):
            t = self.card(tiles)
            t.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 6, 0 if i == 2 else 6))
            self.label(t, title, 11, color=FAINT).pack(fill="x", padx=16, pady=(14, 0))
            val = self.label(t, "—", 24, True)
            val.pack(fill="x", padx=16)
            cap = self.label(t, "", 11, color=MUTED, wraplength=130)
            cap.pack(fill="x", padx=16, pady=(0, 14))
            self.tiles[key] = (val, cap)

        form = self.card(page)
        form.pack(fill="x", pady=(0, 12))
        body = ctk.CTkFrame(form, fg_color="transparent")
        body.pack(fill="x", padx=20, pady=16)
        self.label(body, "Nova versão", 12, color=MUTED).pack(fill="x", pady=(0, 4))
        vrow = ctk.CTkFrame(body, fg_color="transparent")
        vrow.pack(fill="x")
        self.e_version = self.entry(vrow, "1.2.44", width=130)
        self.e_version.pack(side="left")
        for part, text in (("patch", "+ correção"), ("minor", "+ recurso"), ("major", "+ maior")):
            self.ghost_button(vrow, text, lambda pt=part: self._bump(pt), width=88, height=38, action=False).pack(side="left", padx=(8, 0))

        self.publish_var = tk.BooleanVar(value=True)
        self.publish_sw = ctk.CTkSwitch(
            body,
            text="Publicar como padrão (os apps atualizam sozinhos)",
            variable=self.publish_var,
            font=self.font(13),
            text_color=TEXT,
            progress_color=self.accent,
        )
        self.publish_sw.pack(fill="x", pady=(14, 2))
        self.wrap(
            self.label(
                body,
                "Desligado: o instalador sobe para a VPS como beta, sem avisar ninguém. Depois dá para promover em Versões na VPS.",
                11,
                color=FAINT,
            )
        ).pack(fill="x")

        steps = self.card(page)
        steps.pack(fill="x", pady=(0, 12))
        self.step_rows: list[tuple[ctk.CTkLabel, ctk.CTkLabel]] = []
        sbody = ctk.CTkFrame(steps, fg_color="transparent")
        sbody.pack(fill="x", padx=20, pady=12)
        for title in (
            "Atualizar a versão no package.json",
            "Gerar o instalador (electron-builder)",
            "Enviar para a VPS",
            "Publicar como padrão",
        ):
            row = ctk.CTkFrame(sbody, fg_color="transparent")
            row.pack(fill="x", pady=4)
            icon = self.label(row, "○", 16, True, FAINT, width=26)
            icon.pack(side="left", anchor="n")
            text = ctk.CTkFrame(row, fg_color="transparent")
            text.pack(side="left", fill="x", expand=True, padx=(6, 0))
            self.label(text, title, 13, True).pack(fill="x")
            detail = self.label(text, "", 11, color=MUTED)
            detail.pack(fill="x")
            self.step_rows.append((icon, detail))

        actions = ctk.CTkFrame(page, fg_color="transparent")
        actions.pack(fill="x", pady=(4, 8))
        self.primary_button(actions, "Gerar e publicar", lambda: self._start_desktop(build=True), width=200).pack(side="left")
        self.ghost_button(
            actions, "Só enviar o último build", lambda: self._start_desktop(build=False), width=190, height=42
        ).pack(side="left", padx=10)

    def _bump(self, part: str) -> None:
        if not (self.profile and self.profile.desktop and self.repo):
            return
        base = self.e_version.get().strip()
        if not core.valid_version(base):
            base = core.read_desktop_version(self.repo, self.profile.desktop)
        self.set_entry(self.e_version, core.bump_version(base, part))

    def _set_step(self, idx: int, state: str, detail: str = "") -> None:
        icon, det = self.step_rows[idx]
        glyph, color = STEP_ICONS[state]
        icon.configure(text=glyph, text_color=color or self.accent)
        det.configure(text=detail)

    def _refresh_desktop_tiles(self) -> None:
        p, repo = self.profile, self.repo
        if not (p and p.desktop and repo):
            return
        try:
            code_ver = core.read_desktop_version(repo, p.desktop)
        except OSError:
            code_ver = "?"
        self.tiles["code"][0].configure(text=code_ver or "?")
        self.tiles["code"][1].configure(text="package.json")
        local = core.read_local_feed(repo, p.desktop)
        self.tiles["build"][0].configure(text=(local or {}).get("version") or "—")
        self.tiles["build"][1].configure(text=p.desktop.releases_dir if local else "nenhum build ainda")
        cur = (self.feed_data or {}).get("current") or {}
        self.tiles["live"][0].configure(text=cur.get("version") or "—")
        self.tiles["live"][1].configure(
            text="no feed da VPS" if self.feed_data else "ver em Versões"
        )
        if not core.valid_version(self.e_version.get().strip()) and core.valid_version(code_ver):
            self.set_entry(self.e_version, core.bump_version(code_ver, "patch"))

    # ------------------------------------------------------------------ página: versões

    def _build_versions_page(self) -> None:
        page = self._page("versions")

        bar = self.card(page)
        bar.pack(fill="x", pady=(4, 12))
        inner = ctk.CTkFrame(bar, fg_color="transparent")
        inner.pack(fill="x", padx=16, pady=12)
        self.ghost_button(inner, "↻  Atualizar lista", self._refresh_versions, width=150).pack(side="left")
        self.disk_lbl = self.label(inner, "", 12, color=MUTED)
        self.disk_lbl.pack(side="left", padx=14)
        inner = ctk.CTkFrame(bar, fg_color="transparent")
        inner.pack(fill="x", padx=16, pady=(0, 12))
        self.label(inner, "Manter a padrão e as", 12, color=MUTED).pack(side="left")
        self.keep_var = tk.StringVar(value=str(self.cfg.get("keep_versions", 3)))
        ctk.CTkOptionMenu(
            inner,
            values=[str(n) for n in range(1, 11)],
            variable=self.keep_var,
            width=64,
            height=36,
            corner_radius=9,
            fg_color=INPUT,
            button_color=BORDER,
            button_hover_color=CARD_HOVER,
            text_color=TEXT,
            font=self.font(12, True),
        ).pack(side="left", padx=8)
        self.label(inner, "mais novas", 12, color=MUTED).pack(side="left")
        self.ghost_button(inner, "Limpar antigas", self._cleanup_versions, width=130, danger=True).pack(side="right")

        head = ctk.CTkFrame(page, fg_color="transparent")
        head.pack(fill="x", padx=16)
        self._table_cols(head, ("Versão", "Tamanho", "Enviada", ""), header=True)

        self.rows_host = ctk.CTkFrame(page, fg_color="transparent")
        self.rows_host.pack(fill="x", pady=(4, 12))

        note = self.card(page, fg_color="#15192a")
        note.pack(fill="x", pady=(0, 12))
        self.label(note, "Como funciona a versão padrão", 13, True, WARN).pack(fill="x", padx=18, pady=(14, 2))
        self.wrap(
            self.label(
                note,
                "A padrão é a que o latest.yml anuncia: instalações novas e apps em versões anteriores atualizam para ela. "
                "Quem já instalou uma versão mais nova continua nela, porque o app não faz downgrade automático. "
                "Para tirar uma versão ruim de circulação, defina a anterior como padrão e publique uma correção com número maior. "
                "Cada troca guarda backup do latest.yml na VPS (os 5 últimos).",
                12,
                color=MUTED,
            )
        ).pack(fill="x", padx=18, pady=(0, 14))

    def _table_cols(self, parent, cells, header=False) -> list:
        widths = (160, 76, 96, 150)
        out = []
        for i, (cell, width) in enumerate(zip(cells, widths)):
            if isinstance(cell, str):
                w = self.label(parent, cell, 11 if header else 13, header, FAINT if header else TEXT, width=width)
            else:
                w = cell
            w.grid(row=0, column=i, sticky="w", padx=(0, 8))
            out.append(w)
        parent.grid_columnconfigure(len(cells) - 1, weight=1)
        return out

    def _render_versions(self) -> None:
        for child in self.rows_host.winfo_children():
            child.destroy()
        data = self.feed_data
        if not data:
            self.disk_lbl.configure(text="")
            self.label(
                self.rows_host, "Clique em “Atualizar lista” para ler as versões da VPS.", 13, color=MUTED
            ).pack(fill="x", padx=16, pady=20)
            return
        free, total = data.get("free", 0), data.get("total", 0)
        self.disk_lbl.configure(text=f"Disco livre: {core.human_size(free)} de {core.human_size(total)}")
        current = (data.get("current") or {}).get("path", "")
        versions = data.get("versions") or []
        if not versions:
            self.label(self.rows_host, "Nenhum instalador na VPS ainda.", 13, color=MUTED).pack(fill="x", padx=16, pady=20)
        served = data.get("served") or []
        for v in versions:
            is_cur = v["file"] == current
            row = ctk.CTkFrame(
                self.rows_host,
                fg_color=CARD_HOVER if is_cur else CARD,
                corner_radius=12,
                border_width=1,
                border_color=self.accent if is_cur else BORDER,
            )
            row.pack(fill="x", pady=4)
            inner = ctk.CTkFrame(row, fg_color="transparent")
            inner.pack(fill="x", padx=16, pady=10)

            name = ctk.CTkFrame(inner, fg_color="transparent", width=160, height=30)
            name.pack_propagate(False)
            self.label(name, v["version"], 15, True).pack(side="left")
            missing = [d for d in served if d not in v.get("dirs", [])]
            if is_cur:
                self.chip(name, "PADRÃO", self.accent).pack(side="left", padx=8)
            elif "-" in v["version"]:
                self.chip(name, "beta", WARN).pack(side="left", padx=8)
            elif missing:
                # "Tornar padrão" copia para o espelho que falta
                self.chip(name, "sem espelho", MUTED).pack(side="left", padx=8)

            when = datetime.fromtimestamp(v.get("mtime", 0)).strftime("%d/%m %H:%M")

            acts = ctk.CTkFrame(inner, fg_color="transparent")
            if not is_cur:
                self.ghost_button(
                    acts, "★ Padrão", lambda f=v["file"], ver=v["version"]: self._set_default(f, ver), width=86, height=30
                ).pack(side="left")
                self.ghost_button(
                    acts, "Excluir", lambda f=v["file"], ver=v["version"]: self._delete_versions([(f, ver)]), width=64, height=30, danger=True
                ).pack(side="left", padx=6)
            else:
                self.label(acts, "no ar", 12, color=MUTED).pack(side="left")
            self._table_cols(inner, (name, core.human_size(v.get("size", 0)), when, acts))
        self._set_busy_buttons()

    # ------------------------------------------------------------------ navegação

    def _open_system(self, prof: core.SystemProfile) -> None:
        if self.busy:
            return
        repo = core.repo_path(prof, self.cfg)
        if not core.repo_ok(prof, repo):
            if not messagebox.askyesno(
                prof.name, f"Não achei o projeto em:\n{repo}\n\nQuer escolher a pasta dele?"
            ) or not self._pick_repo(prof):
                return
            repo = core.repo_path(prof, self.cfg)
        self.profile, self.repo = prof, repo
        self.feed_data = None
        self.cfg["last_system"] = prof.key
        core.save_config(self.cfg)

        self.sys_name.configure(text=prof.name)
        self.sys_tag.configure(text=prof.tagline)
        self.sys_repo.configure(text=str(repo))
        self._set_accent(prof.accent)
        self.row_ssl.configure(progress_color=prof.accent)
        self.publish_sw.configure(progress_color=prof.accent)
        self._refresh_side_vps()

        self.info_vals["dest"].configure(text=prof.app_dir)
        self.info_vals["service"].configure(text=prof.service)
        for key in ("status", "deploy", "url"):
            self.info_vals[key].configure(text="—", text_color=TEXT)
        self.info_vals["port"].configure(text=str(prof.default_port))
        self._render_history()
        self._apply_overview()

        self.e_domain.configure(placeholder_text=f"Ex: {prof.domain_hint}")
        self.set_entry(self.e_domain, prof.default_domain)
        titulo_dominio = (
            "Domínio do painel administrativo" if prof.public_domain_hint else "Domínio (DNS A apontando para a VPS)"
        )
        self.row_domain.winfo_children()[0].configure(text=titulo_dominio)
        self.e_public.configure(placeholder_text=f"Ex: {prof.public_domain_hint}")
        self.set_entry(self.e_public, prof.default_public_domain)
        self.set_entry(self.e_port, str(prof.default_port))
        for child in self.row_options.winfo_children():
            child.destroy()
        self.option_vars = {}
        for opt in prof.options:
            var = tk.BooleanVar(value=opt.default)
            self.option_vars[opt.key] = var
            ctk.CTkSwitch(
                self.row_options,
                text=opt.label,
                variable=var,
                font=self.font(13),
                text_color=TEXT,
                progress_color=prof.accent,
            ).pack(fill="x", pady=4)
        self.mode_seg.configure(selected_color=shade(prof.accent, 0.35), selected_hover_color=shade(prof.accent, 0.4))
        self.mode_seg.set("Atualizar código")
        self._layout_server()

        has_desktop = prof.desktop is not None
        for key in ("desktop", "versions"):
            self.nav_buttons[key].configure(state="normal" if has_desktop else "disabled")
        self.nav_note.configure(text="" if has_desktop else "Este sistema não tem app desktop.")
        if has_desktop:
            self.set_entry(self.e_version, "")
            for i in range(4):
                self._set_step(i, "idle")
            self._refresh_desktop_tiles()
        self._render_versions()

        self.start_view.pack_forget()
        self.main_view.pack(fill="both", expand=True)
        self.title(f"{prof.name} · Central de Deploy")
        self._show_page("server")

    def _back_to_start(self) -> None:
        if self.busy:
            return
        self._refresh_cards()
        self._show_start()

    def _show_page(self, key: str) -> None:
        titles = {
            "server": ("Servidor", "Instalar do zero ou atualizar o código deste sistema na VPS."),
            "desktop": ("App desktop", "Gera um novo instalador Electron e publica na VPS."),
            "versions": ("Versões na VPS", "Instaladores guardados na VPS. Escolha qual é o padrão e apague os antigos."),
        }
        for page in self.pages.values():
            page.pack_forget()
        self.pages[key].pack(fill="both", expand=True)
        self.current_page = key
        title, sub = titles[key]
        self.page_title.configure(text=title)
        self.page_sub.configure(text=sub)
        for name, btn in self.nav_buttons.items():
            active = name == key
            btn.configure(
                fg_color=CARD if active else "transparent",
                text_color=self.accent if active else TEXT,
            )
        if key == "desktop":
            self._refresh_desktop_tiles()
        if key == "versions" and self.feed_data is None and self.conn_state == "ok" and not self.busy:
            self._refresh_versions()

    def _refresh_side_vps(self) -> None:
        host = self.e_host.get().strip() or "(sem host)"
        user = self.e_user.get().strip() or "root"
        self.side_vps.configure(text=f"{user}@{host}")
        labels = {
            "idle": ("não testada", MUTED),
            "ok": ("● conectada", SUCCESS),
            "fail": ("● falhou", DANGER),
        }
        text, color = labels[self.conn_state]
        self.side_vps_state.configure(text=text, text_color=color)
        self.conn_badge.configure(text=f"  {text}  ", text_color=color)

    # ------------------------------------------------------------------ fila UI ↔ threads

    def _ui(self, fn) -> None:
        self.q.put(("call", fn))

    def _log(self, text: str) -> None:
        self.q.put(("log", text))

    def _progress(self, pct: float, status: str) -> None:
        self.q.put(("progress", pct, status))

    def _ask(self, title: str, message: str) -> bool:
        """Chamado de uma thread de trabalho: pergunta na UI e espera a resposta."""
        done = threading.Event()
        holder = {"answer": False}
        self.q.put(("ask", title, message, done, holder))
        done.wait()
        return holder["answer"]

    def _confirm_host_key(self, hostname: str, key_type: str, fp: str) -> bool:
        return self._ask(
            "Confirmar servidor",
            f"Primeira conexão com {hostname}.\n\n"
            f"Chave {key_type}:\n{fp}\n\n"
            "Se você tem acesso ao painel da VPS, confira se a chave é a mesma "
            "(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub).\n\nConfiar neste servidor?",
        )

    def _drain(self) -> None:
        try:
            while True:
                item = self.q.get_nowait()
                kind = item[0]
                if kind == "log":
                    self._append_log(item[1])
                elif kind == "progress":
                    self._paint_progress(item[1], item[2])
                elif kind == "call":
                    item[1]()
                elif kind == "ask":
                    _k, title, message, done, holder = item
                    holder["answer"] = messagebox.askyesno(title, message, parent=self)
                    done.set()
        except queue.Empty:
            pass
        self.after(60, self._drain)

    def _append_log(self, text: str, tag: str | None = None) -> None:
        text = text.replace("\r", "").rstrip()
        if not text:
            return
        if tag is None:
            low = text.lower()
            if low.startswith(("erro", "error", "falha", "fatal")) or " err!" in low:
                tag = "err"
            elif text.startswith("==>"):
                tag = "head"
        self.log.configure(state="normal")
        self.log.insert("end", datetime.now().strftime("%H:%M:%S  "), "time")
        self.log.insert("end", text + "\n", tag or "")
        lines = int(self.log.index("end-1c").split(".")[0])
        if lines > 5000:
            self.log.delete("1.0", f"{lines - 4000}.0")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _paint_progress(self, pct: float, status: str) -> None:
        pct = max(0.0, min(100.0, float(pct)))
        self.progress.set(pct / 100)
        self.pct_lbl.configure(text=f"{int(pct)}%")
        if status:
            self.status_lbl.configure(text=status)

    def _clear_log(self) -> None:
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

    def _copy_log(self) -> None:
        self.clipboard_clear()
        self.clipboard_append(self.log.get("1.0", "end"))

    # ------------------------------------------------------------------ visão da VPS

    ACTIONS = {
        "install": "Instalação",
        "update": "Atualização",
        "desktop-publish": "App publicado",
        "desktop-upload": "App enviado (beta)",
        "desktop-default": "Padrão do app trocado",
        "desktop-delete": "Versões do app excluídas",
    }

    @staticmethod
    def _when(ts: int) -> str:
        return datetime.fromtimestamp(ts).strftime("%d/%m/%y %H:%M") if ts else "—"

    @staticmethod
    def _ago(seconds: float) -> str:
        seconds = max(0, int(seconds))
        if seconds < 3600:
            return f"{max(1, seconds // 60)} min"
        if seconds < 86400:
            return f"{seconds // 3600} h"
        return f"{seconds // 86400} d"

    def _refresh_overview_quietly(self, client) -> None:
        try:
            self.overview = core.vps_overview(client)
        except Exception as exc:  # noqa: BLE001
            self._log(f"Aviso: não consegui atualizar o estado da VPS ({exc})")

    @staticmethod
    def _ref(event: dict) -> str:
        ref = " ".join(x for x in (event.get("version"), event.get("commit"), event.get("branch")) if x)
        if event.get("dirty"):
            ref += " (com alterações locais)"
        return ref or "sem git"

    def _describe(self, prof: core.SystemProfile, info: dict | None, now: int) -> tuple[str, str, list[str]]:
        if not info:
            return "○  Sem dados", FAINT, []
        unit = info.get("unit") or {}
        load, active, sub = unit.get("LoadState", ""), unit.get("ActiveState", ""), unit.get("SubState", "")
        no_unit = load in ("", "not-found")
        if not info.get("installed") and no_unit:
            return "○  Não instalado nesta VPS", FAINT, []
        since = core.unit_since(unit)
        if active == "active":
            if since:
                state = f"●  No ar há {self._ago(now - since)}"
            elif unit.get("ActiveEnterTimestamp"):
                state = f"●  No ar desde {unit['ActiveEnterTimestamp']}"
            else:
                state = "●  No ar"
            color = SUCCESS
            if not info.get("port_open"):
                state += f" · porta {info.get('port')} fechada"
                color = WARN
        elif active in ("activating", "reloading", "deactivating"):
            state, color = f"●  {active}…", WARN
        elif no_unit:
            state, color = "●  Pasta existe, sem serviço systemd", WARN
        else:
            state, color = f"●  Parado ({sub or active})", DANGER
        details = []
        last = info.get("last_deploy")
        if last:
            what = "Instalado" if last.get("action") == "install" else "Deploy"
            details.append(f"{what} {self._when(last.get('ts', 0))} · {self._ref(last)}")
        elif info.get("code_written"):
            details.append(f"Código gravado ≈ {self._when(info['code_written'])} (antes da Central)")
        if prof.desktop:
            details.append(f"App desktop no ar: {info.get('feed') or '—'}")
        restarts = unit.get("NRestarts", "0")
        if restarts.isdigit() and int(restarts) > 0:
            details.append(f"Reiniciou {restarts}x sozinho")
        mem = unit.get("MemoryCurrent", "")
        if mem.isdigit() and int(mem) < 1 << 50:
            details.append(f"RAM {core.human_size(int(mem))}")
        return state, color, details

    def _apply_overview(self) -> None:
        ov = self.overview
        if not ov:
            return
        now = ov.get("now", 0)
        by_key = {s["key"]: s for s in ov.get("systems", [])}
        for prof in core.PROFILES:
            refs = self.system_cards[prof.key]
            state, color, details = self._describe(prof, by_key.get(prof.key), now)
            refs["state"].configure(text=state, text_color=color)
            refs["detail"].configure(text="\n".join(details))

        mem = ov.get("mem") or {}
        disk = ov.get("disk") or {}
        load = ov.get("load") or [0]
        parts = [f"✓ {ov.get('host', '')}", ov.get("os", "")]
        if ov.get("uptime"):
            parts.append(f"ligada há {self._ago(ov['uptime'])}")
        parts.append(f"carga {load[0]:.2f}")
        if mem.get("MemTotal"):
            used = mem["MemTotal"] - mem.get("MemAvailable", 0)
            parts.append(f"RAM {core.human_size(used)} de {core.human_size(mem['MemTotal'])}")
        if disk.get("total"):
            parts.append(f"disco livre {core.human_size(disk['free'])} de {core.human_size(disk['total'])}")
        self.conn_detail.configure(text="  ·  ".join(x for x in parts if x), text_color=SUCCESS)

        for child in self.infra_row.winfo_children():
            child.destroy()
        if ov.get("infra"):
            self.label(self.infra_row, "Infra:", 11, True, FAINT).pack(side="left", padx=(0, 6))
        for item in ov.get("infra", []):
            active = item["unit"].get("ActiveState")
            self.chip(self.infra_row, f"● {item['name']}", SUCCESS if active == "active" else DANGER).pack(
                side="left", padx=(0, 6)
            )
        if ov.get("others"):
            self.label(
                self.infra_row, "  Outros em /opt: " + ", ".join(ov["others"]), 11, color=FAINT
            ).pack(side="left")

        p = self.profile
        if not p:
            return
        info = by_key.get(p.key)
        state, color, _details = self._describe(p, info, now)
        self.info_vals["status"].configure(text=state.strip("●○ "), text_color=color)
        last = (info or {}).get("last_deploy")
        if last:
            self.info_vals["deploy"].configure(text=f"{self._when(last.get('ts', 0))} · {self._ref(last)}")
        elif (info or {}).get("code_written"):
            self.info_vals["deploy"].configure(text=f"≈ {self._when(info['code_written'])} (estimado)")
        else:
            self.info_vals["deploy"].configure(text="—")
        if info:
            porta = "aberta" if info.get("port_open") else "fechada"
            self.info_vals["port"].configure(text=f"{p.default_port} · {porta}")
        public_url = (info or {}).get("public_url") or ""
        self.info_vals["url"].configure(text=public_url or "—")
        # Preenche o domínio com o que já está configurado na VPS
        if public_url and not self.e_domain.get().strip():
            self.set_entry(self.e_domain, core.extract_domain(public_url))
        self._render_history()

    def _render_history(self) -> None:
        for child in self.history_host.winfo_children():
            child.destroy()
        p = self.profile
        events = [e for e in (self.overview or {}).get("history", []) if p and e.get("system") == p.key]
        if not events:
            self.label(
                self.history_host,
                "Nada registrado ainda." if self.overview else "Clique em Verificar serviço para ler da VPS.",
                12,
                color=MUTED,
            ).pack(fill="x", padx=6, pady=4)
            return
        for e in reversed(events[-10:]):
            row = ctk.CTkFrame(self.history_host, fg_color=INPUT, corner_radius=10)
            row.pack(fill="x", pady=3)
            top = ctk.CTkFrame(row, fg_color="transparent")
            top.pack(fill="x", padx=12, pady=(7, 0))
            self.label(top, self.ACTIONS.get(e.get("action"), e.get("action", "?")), 12, True).pack(side="left")
            self.label(top, self._when(e.get("ts", 0)), 11, color=MUTED).pack(side="right")
            detail = self._ref(e)
            if e.get("previous"):
                detail = f"{e['previous']} → {detail}"
            if e.get("subject"):
                detail += f" · {e['subject']}"
            detail += f" · por {e.get('operator', '?')}"
            self.label(row, detail, 11, color=MUTED, wraplength=520).pack(fill="x", padx=12, pady=(0, 7))

    # ------------------------------------------------------------------ execução

    def _conn(self) -> core.VpsConn | None:
        host = self.e_host.get().strip().replace("https://", "").replace("http://", "")
        host = host.split("/")[0].split(":")[0]
        password = self.e_pass.get()
        try:
            port = int(self.e_sshport.get().strip() or "22")
        except ValueError:
            messagebox.showerror("VPS", "A porta SSH precisa ser um número.")
            return None
        if not host or not password:
            messagebox.showerror("VPS", "Preencha o host e a senha da VPS na tela inicial (Trocar sistema).")
            return None
        user = self.e_user.get().strip() or "root"
        self.cfg.update({"host": host, "user": user, "ssh_port": port})
        core.save_config(self.cfg)
        return core.VpsConn(host=host, port=port, user=user, password=password)

    def _set_busy_buttons(self) -> None:
        alive = []
        for btn in self.action_buttons:
            try:
                btn.configure(state="disabled" if self.busy else "normal")
                alive.append(btn)
            except tk.TclError:
                pass
        self.action_buttons = alive

    def _run(self, title: str, work, on_done=None, announce: bool = True) -> None:
        """Roda `work(client)` numa thread com SSH aberto. on_done(result) roda na UI."""
        if self.busy:
            return
        conn = self._conn()
        if not conn:
            return
        self.busy = True
        self._set_busy_buttons()
        self.progress.configure(progress_color=self.accent)
        self._paint_progress(2, title)
        self._append_log(title, "head")

        def job() -> None:
            client = None
            try:
                self._progress(4, f"Conectando em {conn.user}@{conn.host}…")
                client = core.connect(conn, self._confirm_host_key)
                self.conn_state = "ok"
                self._ui(self._refresh_side_vps)
                result = work(client)
                self._ui(lambda r=result: self._finish(True, r, on_done, announce))
            except Cancelled:
                self._ui(lambda: self._finish(None, "Cancelado.", None, False))
            except Exception as exc:  # noqa: BLE001
                msg = core.describe_error(exc)
                if client is None:
                    self.conn_state = "fail"
                    self._ui(self._refresh_side_vps)
                self._ui(lambda m=msg: self._finish(False, m, None, True))
            finally:
                if client is not None:
                    client.close()

        threading.Thread(target=job, daemon=True).start()

    def _finish(self, ok: bool | None, result, on_done, announce: bool) -> None:
        self.busy = False
        self._set_busy_buttons()
        self._apply_overview()
        if ok:
            self.progress.configure(progress_color=SUCCESS)
            self._paint_progress(100, "Concluído")
            message = on_done(result) if on_done else result
            if isinstance(message, str) and message:
                self._append_log(message, "ok")
                if announce:
                    messagebox.showinfo("Concluído", message, parent=self)
        elif ok is None:
            self._paint_progress(0, "Cancelado")
            self._append_log(str(result))
        else:
            self.progress.configure(progress_color=DANGER)
            self.status_lbl.configure(text="Falhou")
            self._append_log(str(result), "err")
            if announce:
                messagebox.showerror("Falhou", str(result), parent=self)

    def _test_connection(self) -> None:
        def work(client):
            self._progress(40, "Lendo o estado da VPS…")
            self.overview = core.vps_overview(client)
            return self.overview

        def done(ov: dict) -> str:
            running = sum(1 for s in ov.get("systems", []) if s["unit"].get("ActiveState") == "active")
            return f"Conectado em {ov.get('host')}: {running} sistema(s) no ar."

        self._run("Conectando…", work, done, announce=False)
        self.after(200, self._watch_conn_fail)

    def _watch_conn_fail(self) -> None:
        if self.busy:
            self.after(200, self._watch_conn_fail)
            return
        self._refresh_side_vps()
        if self.conn_state == "fail":
            self.conn_detail.configure(text=self.status_lbl.cget("text"), text_color=DANGER)

    # ------------------------------------------------------------------ ações: servidor

    def _start_deploy(self) -> None:
        p = self.profile
        if not p or not self.repo:
            return
        install = self.mode_seg.get() == "Instalar do zero"
        try:
            port = int(self.e_port.get().strip() or p.default_port)
        except ValueError:
            messagebox.showerror("Porta", "A porta precisa ser um número.")
            return
        req = core.DeployRequest(
            profile=p,
            repo=self.repo,
            mode="install" if install else "update",
            domain=core.extract_domain(self.e_domain.get()),
            public_domain=core.extract_domain(self.e_public.get()) if p.public_domain_hint else "",
            port=port,
            enable_ssl=bool(self.ssl_var.get()),
            ssl_email=self.e_email.get().strip(),
            options={k: bool(v.get()) for k, v in self.option_vars.items()},
        )
        err = core.validate_request(req)
        if err:
            messagebox.showerror("Dados", err)
            return
        if req.ssl_email:
            self.cfg["ssl_email"] = req.ssl_email
        lines = [
            f"{'Instalar' if install else 'Atualizar'} {p.name} em {self.e_user.get().strip() or 'root'}@{self.e_host.get().strip()}",
            "",
            f"Código: {self.repo}",
            f"Destino: {p.app_dir}",
        ]
        if req.effective_domain():
            lines.append(f"Painel: {req.effective_domain()}  (HTTPS: {'sim' if req.enable_ssl else 'não'})")
        if req.effective_public_domain():
            lines.append(f"Fila e agenda: {req.effective_public_domain()}")
        if install:
            lines.append(f"Porta local: {port}")
            for opt in p.options:
                lines.append(f"{opt.label}: {'sim' if req.options.get(opt.key) else 'não'}")
        else:
            lines += ["", p.update_desc]
        if not messagebox.askyesno("Confirmar", "\n".join(lines)):
            return
        verb = "Instalando" if install else "Atualizando"
        def work(client):
            msg = core.deploy_system(client, req, self._progress, self._log)
            self._refresh_overview_quietly(client)
            return msg

        self._run(f"{verb} {p.name}…", work)

    def _check_service(self) -> None:
        p = self.profile
        if not p:
            return

        def work(client):
            self.overview = core.vps_overview(client)
            return self.overview

        def done(ov: dict) -> str:
            info = next((s for s in ov.get("systems", []) if s["key"] == p.key), None)
            state, _color, details = self._describe(p, info, ov.get("now", 0))
            return " · ".join([state.strip("●○ ")] + details[:2])

        self._run(f"Verificando {p.service}…", work, done, announce=False)

    # ------------------------------------------------------------------ ações: desktop

    def _start_desktop(self, build: bool) -> None:
        p, repo = self.profile, self.repo
        if not (p and p.desktop and repo):
            return
        d = p.desktop
        publish = bool(self.publish_var.get())
        code_ver = core.read_desktop_version(repo, d)

        if build:
            version = self.e_version.get().strip()
            if not core.valid_version(version):
                messagebox.showerror("Versão", "Use o formato 1.2.44 (ou 1.3.0-beta.1).")
                return
            if core.version_key(version) <= core.version_key(code_ver) and not messagebox.askyesno(
                "Versão",
                f"A versão {version} não é maior que a do código ({code_ver}).\n"
                "Os apps instalados não atualizam para uma versão igual ou menor.\n\nContinuar mesmo assim?",
            ):
                return
        else:
            local = core.read_local_feed(repo, d)
            if not local or not local.get("version"):
                messagebox.showerror("Build", "Não há build local. Use “Gerar e publicar”.")
                return
            version = local["version"]

        live = ((self.feed_data or {}).get("current") or {}).get("version", "")
        if publish and live and core.version_key(version) < core.version_key(live):
            if not messagebox.askyesno(
                "Versão menor que a do ar",
                f"A VPS anuncia {live} e você vai publicar {version}.\n"
                f"Quem já está na {live} não volta. Continuar?",
            ):
                return

        steps = (
            ["versão → " + version, "npm run dist:publish", "SFTP para a VPS"]
            if build
            else ["pula (usa o build existente)", "pula", "SFTP para a VPS"]
        )
        summary = (
            f"{'Gerar e publicar' if build else 'Enviar'} {p.name} {version}\n\n"
            + ("1. package.json do desktop vai para " + version + "\n2. electron-builder gera o instalador (alguns minutos)\n" if build else "")
            + f"{'3' if build else '1'}. Envia para {d.served_dirs[0]}\n"
            + (f"{'4' if build else '2'}. Publica como padrão: os apps atualizam para {version}" if publish else "Não vira padrão (fica como beta na VPS)")
        )
        if not messagebox.askyesno("Confirmar", summary):
            return

        for i in range(4):
            self._set_step(i, "idle")
        if not build:
            self._set_step(0, "skip", steps[0])
            self._set_step(1, "skip", steps[1])

        prepared: dict = {}

        def prepare_local() -> None:
            if not build:
                files, sha, ver = core.local_release(repo, d)
                prepared.update(files=files, sha=sha, version=ver)
                return
            self._ui(lambda: self._set_step(0, "run"))
            old_text = core.write_desktop_version(repo, d, version)
            self._ui(lambda: self._set_step(0, "ok", f"{code_ver} → {version}"))
            self._ui(lambda: self._set_step(1, "run", d.build_cmd))
            self._progress(8, "Gerando o instalador… (alguns minutos)")
            code = core.run_local(d.build_cmd, repo, self._log)
            if code != 0:
                core.restore_desktop_package(repo, d, old_text)
                self._ui(lambda: self._set_step(0, "fail", f"voltou para {code_ver}"))
                self._ui(lambda: self._set_step(1, "fail", f"saiu com código {code}"))
                raise RuntimeError(
                    "O build do Electron falhou (veja a atividade).\n"
                    f"O package.json voltou para {code_ver}."
                )
            files, sha, ver = core.local_release(repo, d, version)
            size = core.human_size(files[0].stat().st_size)
            self._ui(lambda: self._set_step(1, "ok", f"{files[0].name} · {size}"))
            prepared.update(files=files, sha=sha, version=ver)

        def work(client):
            prepare_local()
            files: list[Path] = prepared["files"]
            name = files[0].name
            self._ui(lambda: self._set_step(2, "run", "conferindo espaço"))
            self._progress(40, "Conferindo a VPS…")
            listing = core.feed_call(client, d, "list")
            need = sum(f.stat().st_size for f in files) * max(1, len(listing.get("served") or []))
            if listing.get("free", 0) < need * 1.2:
                raise RuntimeError(
                    f"Pouco espaço na VPS: {core.human_size(listing.get('free', 0))} livres, "
                    f"precisa de {core.human_size(need)}. Apague versões antigas primeiro."
                )
            current_file = (listing.get("current") or {}).get("path", "")
            exists = any(v["file"] == name for v in listing.get("versions") or [])
            if exists and not self._ask(
                "Versão já existe", f"{name} já está na VPS.\nSubstituir pelo build local?"
            ):
                raise Cancelled()
            core.upload_release(client, d, files, self._progress, 42, 90)
            self._ui(lambda: self._set_step(2, "ok", f"{len(files)} arquivo(s)"))

            # Se o arquivo substituído era o padrão, o latest.yml precisa do hash novo
            if publish or name == current_file:
                self._ui(lambda: self._set_step(3, "run"))
                self._progress(94, "Publicando como padrão…")
                res = core.feed_call(client, d, "set-default", name, prepared["sha"])
                prev = (res.get("previous") or {}).get("version") or "nenhuma"
                self._ui(lambda: self._set_step(3, "ok", f"{prev} → {res['version']}"))
                result = f"{p.name} {res['version']} publicado. Padrão anterior: {prev}."
                action = "desktop-publish"
            else:
                self._ui(lambda: self._set_step(3, "skip", "ficou como beta"))
                result = f"{name} enviado para a VPS sem virar padrão."
                action = "desktop-upload"
            core.record_event(
                client, p, action, self._log,
                version=prepared["version"], previous=(listing.get("current") or {}).get("version"),
                **core.local_build_info(repo),
            )
            self.feed_data = core.feed_call(client, d, "list")
            self._refresh_overview_quietly(client)
            return result

        def done(result: str) -> str:
            self._refresh_desktop_tiles()
            self._render_versions()
            return result

        title = f"Gerando {p.name} {version}…" if build else f"Enviando {p.name} {version}…"
        self._run_local_first(title, work, done)

    def _run_local_first(self, title: str, work, on_done) -> None:
        """Como _run, mas o build local acontece antes de abrir o SSH (pode levar minutos)."""
        if self.busy:
            return
        conn = self._conn()
        if not conn:
            return

        class _Deferred:
            """Abre a conexão SSH só quando alguém usa o client."""

            def __init__(self, app: DeployCenter) -> None:
                self.app = app
                self.client = None

            def __getattr__(self, attr):
                if self.client is None:
                    self.app._progress(38, f"Conectando em {conn.user}@{conn.host}…")
                    self.client = core.connect(conn, self.app._confirm_host_key)
                    self.app.conn_state = "ok"
                    self.app._ui(self.app._refresh_side_vps)
                return getattr(self.client, attr)

        self.busy = True
        self._set_busy_buttons()
        self.progress.configure(progress_color=self.accent)
        self._paint_progress(2, title)
        self._append_log(title, "head")

        def job() -> None:
            lazy = _Deferred(self)
            try:
                result = work(lazy)
                self._ui(lambda r=result: self._finish(True, r, on_done, True))
            except Cancelled:
                self._ui(lambda: self._finish(None, "Cancelado.", None, False))
            except Exception as exc:  # noqa: BLE001
                msg = core.describe_error(exc)
                self._ui(lambda m=msg: self._fail_running_steps())
                self._ui(lambda m=msg: self._finish(False, m, None, True))
            finally:
                if lazy.client is not None:
                    lazy.client.close()

        threading.Thread(target=job, daemon=True).start()

    def _fail_running_steps(self) -> None:
        for icon, det in self.step_rows:
            if icon.cget("text") == STEP_ICONS["run"][0]:
                icon.configure(text=STEP_ICONS["fail"][0], text_color=DANGER)

    # ------------------------------------------------------------------ ações: versões

    def _refresh_versions(self) -> None:
        p = self.profile
        if not (p and p.desktop):
            return

        def work(client):
            self._progress(40, "Lendo as versões na VPS…")
            return core.feed_call(client, p.desktop, "list")

        def done(data: dict) -> str:
            self.feed_data = data
            self._render_versions()
            self._refresh_desktop_tiles()
            cur = (data.get("current") or {}).get("version") or "nenhuma"
            return f"{len(data.get('versions') or [])} versões na VPS · padrão: {cur}"

        self._run("Consultando versões…", work, done, announce=False)

    def _set_default(self, file: str, version: str) -> None:
        p = self.profile
        if not (p and p.desktop):
            return
        cur = ((self.feed_data or {}).get("current") or {}).get("version", "")
        direction = ""
        if cur and core.version_key(version) < core.version_key(cur):
            direction = (
                f"\n\nAtenção: {version} é anterior à {cur}. Quem já instalou a {cur} continua nela; "
                "a troca vale para instalações novas e apps mais antigos."
            )
        if not messagebox.askyesno(
            "Tornar padrão",
            f"Anunciar {version} como a versão padrão de {p.name}?{direction}",
        ):
            return

        def work(client):
            self._progress(40, f"Calculando o hash de {file} na VPS…")
            res = core.feed_call(client, p.desktop, "set-default", file)
            core.record_event(
                client, p, "desktop-default", self._log,
                version=res["version"], previous=(res.get("previous") or {}).get("version"),
            )
            self.feed_data = core.feed_call(client, p.desktop, "list")
            self._refresh_overview_quietly(client)
            prev = (res.get("previous") or {}).get("version") or "nenhuma"
            return f"Padrão agora é {res['version']} (antes: {prev})."

        def done(msg: str) -> str:
            self._render_versions()
            self._refresh_desktop_tiles()
            return msg

        self._run(f"Definindo {version} como padrão…", work, done)

    def _delete_versions(self, items: list[tuple[str, str]], confirm: bool = True) -> None:
        p = self.profile
        if not (p and p.desktop and items):
            return
        if confirm:
            names = "\n".join(f"• {ver}" for _f, ver in items)
            if not messagebox.askyesno(
                "Excluir", f"Apagar da VPS (todas as pastas do feed):\n\n{names}\n\nNão dá para desfazer."
            ):
                return

        def work(client):
            self._progress(40, "Apagando…")
            res = core.feed_call(client, p.desktop, "delete", *[f for f, _v in items])
            core.record_event(
                client, p, "desktop-delete", self._log, version=", ".join(v for _f, v in items)
            )
            self.feed_data = core.feed_call(client, p.desktop, "list")
            self._refresh_overview_quietly(client)
            return f"{len(items)} versão(ões) apagada(s), {core.human_size(res.get('freed', 0))} liberados."

        def done(msg: str) -> str:
            self._render_versions()
            return msg

        self._run("Excluindo versões…", work, done)

    def _cleanup_versions(self) -> None:
        if not self.feed_data:
            messagebox.showinfo("Versões", "Atualize a lista primeiro.")
            return
        keep = int(self.keep_var.get())
        self.cfg["keep_versions"] = keep
        core.save_config(self.cfg)
        current = (self.feed_data.get("current") or {}).get("path", "")
        others = [v for v in self.feed_data.get("versions") or [] if v["file"] != current]
        doomed = others[keep:]
        if not doomed:
            messagebox.showinfo("Versões", f"Nada para apagar: há {len(others)} versão(ões) além da padrão.")
            return
        size = core.human_size(sum(v.get("size", 0) for v in doomed))
        names = ", ".join(v["version"] for v in doomed)
        if not messagebox.askyesno(
            "Limpar antigas",
            f"Manter a padrão e as {keep} mais novas.\n\nApagar {len(doomed)} versão(ões) ({size}):\n{names}",
        ):
            return
        self._delete_versions([(v["file"], v["version"]) for v in doomed], confirm=False)

    # ------------------------------------------------------------------ saída

    def _on_close(self) -> None:
        if self.busy and not messagebox.askyesno(
            "Sair", "Há uma operação em andamento. Fechar mesmo assim?"
        ):
            return
        self.destroy()


def main() -> None:
    DeployCenter().mainloop()


if __name__ == "__main__":
    main()
