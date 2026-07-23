"""Splash Win32 minimalista (stdlib ``ctypes``) para o caminho LENTO de install/update.

Mostra uma janela SEM BORDA, topmost, centralizada, com o branding do vox-engine e uma
linha de status ("atualizando o motor de voz…") com reticências animadas. Roda em uma
THREAD própria com seu próprio message loop; ``close()`` a derruba. **Sem dependência
nova** (só ``ctypes`` da stdlib — nada de Pillow). **FAIL-SILENT**: qualquer erro de GUI
vira no-op — NUNCA quebra a instalação. Fora do Windows é um no-op puro.

Por que aqui (e não no daemon): o motor residente sobe UMA vez e headless; a splash
pertence ao trabalho LENTO que o usuário espera — o install/update, rodado pelo
consumidor via ``download_and_run_installer``. É esse processo (no desktop interativo,
mesmo sendo ``pythonw``) que a renderiza.

Uso::

    s = show_splash_async(subtitle="atualizando o motor de voz…")
    ...            # trabalho lento (install.ps1)
    s.close()

Desligar: variável de ambiente ``VOX_SPLASH=0``.
"""
from __future__ import annotations

import sys
import threading

_IS_WIN = sys.platform == "win32"


class _NullSplash:
    """Handle no-op (fora do Windows, desligado, ou em qualquer falha)."""

    def close(self) -> None:  # noqa: D401
        pass


def show_splash_async(title: str = "vox-engine",
                      subtitle: str = "iniciando o motor de voz…"):
    """Sobe a splash em uma thread (NÃO bloqueia). Devolve um handle com ``close()``.

    Fail-silent: fora do Windows, com ``VOX_SPLASH`` desligado, ou em QUALQUER erro de
    GUI, devolve um :class:`_NullSplash` (no-op) — o chamador nunca precisa tratar erro.
    """
    import os
    if not _IS_WIN or os.environ.get("VOX_SPLASH", "").strip().lower() in ("0", "false", "no"):
        return _NullSplash()
    try:
        s = _Splash(str(title), str(subtitle))
        s.start()
        return s
    except Exception:  # noqa: BLE001 — splash é cosmética; jamais derruba o chamador
        return _NullSplash()


# ---------------------------------------------------------------------------
# Implementação Win32 (só importada/usada no Windows).
# ---------------------------------------------------------------------------
if _IS_WIN:
    import ctypes
    from ctypes import wintypes

    _user32 = ctypes.windll.user32
    _gdi32 = ctypes.windll.gdi32
    _kernel32 = ctypes.windll.kernel32

    # LRESULT/DefWindowProc com tipos corretos (evita truncamento de ponteiro em 64-bit).
    _user32.DefWindowProcW.argtypes = [wintypes.HWND, ctypes.c_uint,
                                       wintypes.WPARAM, wintypes.LPARAM]
    _user32.DefWindowProcW.restype = wintypes.LPARAM
    _WNDPROC = ctypes.WINFUNCTYPE(wintypes.LPARAM, wintypes.HWND, ctypes.c_uint,
                                  wintypes.WPARAM, wintypes.LPARAM)
    _user32.DrawTextW.argtypes = [wintypes.HDC, wintypes.LPCWSTR, ctypes.c_int,
                                  ctypes.POINTER(wintypes.RECT), ctypes.c_uint]

    _WS_POPUP = 0x80000000
    _WS_EX_TOPMOST = 0x00000008
    _WS_EX_TOOLWINDOW = 0x00000080
    _SW_SHOWNOACTIVATE = 4
    _SM_CXSCREEN, _SM_CYSCREEN = 0, 1
    _WM_DESTROY, _WM_PAINT, _WM_CLOSE, _WM_ERASEBKGND, _WM_TIMER = (
        0x0002, 0x000F, 0x0010, 0x0014, 0x0113)
    _DT_CENTER, _DT_SINGLELINE = 0x0001, 0x0020
    _TRANSPARENT = 1

    _W, _H = 320, 150

    def _rgb(r: int, g: int, b: int) -> int:
        return r | (g << 8) | (b << 16)

    class _PAINTSTRUCT(ctypes.Structure):
        _fields_ = [("hdc", wintypes.HDC), ("fErase", wintypes.BOOL),
                    ("rcPaint", wintypes.RECT), ("fRestore", wintypes.BOOL),
                    ("fIncUpdate", wintypes.BOOL), ("rgbReserved", ctypes.c_byte * 32)]

    class _WNDCLASSEXW(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("style", ctypes.c_uint),
                    ("lpfnWndProc", _WNDPROC), ("cbClsExtra", ctypes.c_int),
                    ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE),
                    ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE),
                    ("hbrBackground", wintypes.HBRUSH), ("lpszMenuName", wintypes.LPCWSTR),
                    ("lpszClassName", wintypes.LPCWSTR), ("hIconSm", wintypes.HICON)]

    class _Splash(threading.Thread):
        """Janela splash própria (thread + message loop). Tudo em-thread; fail-silent."""

        def __init__(self, title: str, subtitle: str) -> None:
            super().__init__(name="vox-splash", daemon=True)
            self._title = title
            self._subtitle = subtitle
            self._dots = 1
            self._hwnd = None
            self._ready = threading.Event()
            self._proc_ref = None            # segura a WNDPROC viva (anti-GC)
            self._bg = self._title_font = self._sub_font = None

        # -- API pública (thread do chamador) --
        def close(self) -> None:
            try:
                self._ready.wait(2.0)
                h = self._hwnd
                if h:
                    _user32.PostMessageW(h, _WM_CLOSE, 0, 0)
                self.join(2.0)
            except Exception:  # noqa: BLE001
                pass

        # -- thread da janela --
        def run(self) -> None:
            try:
                self._run()
            except Exception:  # noqa: BLE001 — GUI é cosmética; nunca propaga
                pass
            finally:
                self._ready.set()            # destrava um close() que esperava o ready

        def _run(self) -> None:
            hinst = _kernel32.GetModuleHandleW(None)
            cls_name = f"VoxSplash{id(self)}"
            self._proc_ref = _WNDPROC(self._wndproc)
            wc = _WNDCLASSEXW()
            wc.cbSize = ctypes.sizeof(_WNDCLASSEXW)
            wc.lpfnWndProc = self._proc_ref
            wc.hInstance = hinst
            wc.lpszClassName = cls_name
            wc.hCursor = _user32.LoadCursorW(None, ctypes.c_wchar_p(0x7F00))  # IDC_ARROW
            if not _user32.RegisterClassExW(ctypes.byref(wc)):
                return
            self._bg = _gdi32.CreateSolidBrush(_rgb(24, 26, 32))
            self._title_font = _gdi32.CreateFontW(-28, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0,
                                                  4, 0, "Segoe UI")
            self._sub_font = _gdi32.CreateFontW(-15, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0,
                                                4, 0, "Segoe UI")
            sx = _user32.GetSystemMetrics(_SM_CXSCREEN)
            sy = _user32.GetSystemMetrics(_SM_CYSCREEN)
            x, y = (sx - _W) // 2, (sy - _H) // 2
            hwnd = _user32.CreateWindowExW(
                _WS_EX_TOPMOST | _WS_EX_TOOLWINDOW, cls_name, self._title,
                _WS_POPUP, x, y, _W, _H, None, None, hinst, None)
            if not hwnd:
                self._cleanup(hinst, cls_name)
                return
            self._hwnd = hwnd
            self._ready.set()
            _user32.ShowWindow(hwnd, _SW_SHOWNOACTIVATE)
            _user32.UpdateWindow(hwnd)
            _user32.SetTimer(hwnd, 1, 400, None)            # reticências animadas
            msg = wintypes.MSG()
            while _user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                _user32.TranslateMessage(ctypes.byref(msg))
                _user32.DispatchMessageW(ctypes.byref(msg))
            self._cleanup(hinst, cls_name)

        def _cleanup(self, hinst, cls_name) -> None:
            for obj in (self._bg, self._title_font, self._sub_font):
                if obj:
                    try:
                        _gdi32.DeleteObject(obj)
                    except Exception:  # noqa: BLE001
                        pass
            try:
                _user32.UnregisterClassW(cls_name, hinst)
            except Exception:  # noqa: BLE001
                pass

        def _wndproc(self, hwnd, msg, wp, lp):
            if msg == _WM_PAINT:
                self._paint(hwnd)
                return 0
            if msg == _WM_ERASEBKGND:
                return 1
            if msg == _WM_TIMER:
                self._dots = (self._dots % 3) + 1
                _user32.InvalidateRect(hwnd, None, False)
                return 0
            if msg == _WM_DESTROY:
                _user32.KillTimer(hwnd, 1)
                _user32.PostQuitMessage(0)
                return 0
            return _user32.DefWindowProcW(hwnd, msg, wp, lp)

        def _paint(self, hwnd) -> None:
            ps = _PAINTSTRUCT()
            hdc = _user32.BeginPaint(hwnd, ctypes.byref(ps))
            try:
                rc = wintypes.RECT()
                _user32.GetClientRect(hwnd, ctypes.byref(rc))
                _user32.FillRect(hdc, ctypes.byref(rc), self._bg)
                _gdi32.SetBkMode(hdc, _TRANSPARENT)
                _gdi32.SelectObject(hdc, self._title_font)
                _gdi32.SetTextColor(hdc, _rgb(63, 185, 80))      # verde vox
                r1 = wintypes.RECT(0, 34, _W, 78)
                _user32.DrawTextW(hdc, self._title, -1, ctypes.byref(r1),
                                  _DT_CENTER | _DT_SINGLELINE)
                _gdi32.SelectObject(hdc, self._sub_font)
                _gdi32.SetTextColor(hdc, _rgb(200, 205, 212))
                r2 = wintypes.RECT(0, 92, _W, 126)
                _user32.DrawTextW(hdc, self._subtitle + ("." * self._dots), -1,
                                  ctypes.byref(r2), _DT_CENTER | _DT_SINGLELINE)
            finally:
                _user32.EndPaint(hwnd, ctypes.byref(ps))
