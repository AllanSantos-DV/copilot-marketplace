"""Descoberta e resolução de microfones (dispositivos de ENTRADA) — flat VENDORÁVEL.

Portado FIELMENTE de ``vox_engine/client/audio_devices.py``. Este é o arquivo canônico que
os consumidores (copilot-voice, Action, …) copiam BYTE-A-BYTE para o seu ``vendor/`` — o
``sdk/check-drift.mjs`` garante a fidelidade. Standalone: só stdlib + ``sounddevice`` LAZY
(importado dentro das funções), então importa SEM numpy e SEM o extra de captura — ideal para
um consumidor que só quer resolver/enumerar device (ex.: um hub de áudio que segmenta por
conta própria, ou o spotting de wake-word) sem puxar a stack de transcrição.

Guarde a escolha de mic por **NOME** (o índice do PortAudio muda ao plugar/desplugar USB; o
nome é estável). Resolva o nome para o índice na hora de abrir o stream; mic ausente → índice
``None`` (automático do SO), nunca quebra. Deduplica por host API (o mesmo mic físico aparece
1x por MME/DirectSound/WASAPI/WDM-KS, e o MME trunca o nome em 31 chars) — WASAPI/DirectSound
primeiro (nome completo, modo compartilhado seguro). As funções são puras e injetáveis.
"""
from __future__ import annotations

_SENTINEL = object()

# Preferência de host API (Windows): WASAPI/DirectSound dão NOME COMPLETO e modo compartilhado;
# MME trunca em 31 chars; WDM-KS é exclusive-mode → por último. Desconhecida fica no fim.
_HOSTAPI_PREFERENCE = ("Windows WASAPI", "Windows DirectSound", "MME", "Windows WDM-KS")


def _query_devices() -> list:
    """Lista crua de devices do PortAudio (via sounddevice). Import lazy."""
    import sounddevice as sd
    return list(sd.query_devices())


def _query_hostapis() -> list:
    """Lista crua de host APIs do PortAudio (via sounddevice). Import lazy."""
    import sounddevice as sd
    return list(sd.query_hostapis())


def _pick_input_index(dev) -> "int | None":
    """Índice de ENTRADA a partir de ``sd.default.device`` (um ``_InputOutputPair``: indexável
    mas não list/tuple; indexamos direto). ``-1``/sem default -> None."""
    try:
        idx = dev if isinstance(dev, int) else dev[0]
    except (TypeError, IndexError, KeyError):
        return None
    return idx if isinstance(idx, int) and idx >= 0 else None


def _default_input_index() -> "int | None":
    """Índice do device de ENTRADA default do sistema (o 'automático'), ou None."""
    try:
        import sounddevice as sd
        return _pick_input_index(sd.default.device)
    except Exception:  # noqa: BLE001 — sem default detectável -> None (não quebra)
        return None


def _is_input(d: dict) -> bool:
    try:
        return int(d.get("max_input_channels", 0)) > 0
    except (TypeError, ValueError):
        return False


def _api_rank(name: str) -> int:
    try:
        return _HOSTAPI_PREFERENCE.index(name)
    except ValueError:
        return len(_HOSTAPI_PREFERENCE)


def _hostapi_name(d: dict, hostapis: "list | None") -> str:
    if not hostapis:
        return ""
    try:
        return str(hostapis[int(d["hostapi"])].get("name", ""))
    except (KeyError, TypeError, ValueError, IndexError, AttributeError):
        return ""


_MME_NAME_CAP = 31  # o backend MME do PortAudio corta o nome em 31 chars (MAXPNAMELEN)


def _canonical_name(name: str, full_names: "list[str]") -> str:
    """Se ``name`` foi truncado pelo MME (31 chars) e é prefixo de um nome mais longo presente,
    devolve o nome LONGO (canônico) — o mesmo mic físico não vira duas entradas."""
    if len(name) == _MME_NAME_CAP:
        low = name.lower()
        for full in full_names:
            if len(full) > _MME_NAME_CAP and full.lower().startswith(low):
                return full
    return name


def _dedup_inputs(devices: list, hostapis: "list | None") -> list[dict]:
    """Colapsa os devices de ENTRADA por NOME, escolhendo a melhor host API por nome. Retorna
    ``[{index, name}]`` preservando a ordem de primeira aparição."""
    raw: list[dict] = []
    for i, d in enumerate(devices):
        if not isinstance(d, dict) or not _is_input(d):
            continue
        name = str(d.get("name", "")).strip()
        raw.append({"index": i, "name": name,
                    "rank": _api_rank(_hostapi_name(d, hostapis))})
    full_names = [r["name"] for r in raw if len(r["name"]) != _MME_NAME_CAP]
    best: dict[str, dict] = {}
    order = 0
    for r in raw:
        canon = _canonical_name(r["name"], full_names)
        key = canon.lower()
        cur = best.get(key)
        if cur is None:
            best[key] = {"index": r["index"], "name": canon, "rank": r["rank"], "order": order}
            order += 1
        elif r["rank"] < cur["rank"]:
            best[key] = {"index": r["index"], "name": canon,
                         "rank": r["rank"], "order": cur["order"]}
    return [{"index": e["index"], "name": e["name"]}
            for e in sorted(best.values(), key=lambda e: e["order"])]


def list_input_devices(devices: "list | None" = None,
                       default_index: object = _SENTINEL,
                       hostapis: object = _SENTINEL) -> list[dict]:
    """Microfones disponíveis: ``[{index, name, is_default}]`` — só ENTRADAS, deduplicados por
    nome. ``is_default`` marca o mic cujo NOME é o do automático atual. Injetável; nunca levanta
    (PortAudio indisponível -> ``[]``)."""
    if devices is None:
        try:
            devices = _query_devices()
        except Exception:  # noqa: BLE001
            return []
    if default_index is _SENTINEL:
        default_index = _default_input_index()
    if hostapis is _SENTINEL:
        try:
            hostapis = _query_hostapis()
        except Exception:  # noqa: BLE001
            hostapis = None
    default_name = ""
    if isinstance(default_index, int) and 0 <= default_index < len(devices):
        dd = devices[default_index]
        if isinstance(dd, dict):
            default_name = str(dd.get("name", "")).strip().lower()
    out: list[dict] = []
    for e in _dedup_inputs(devices, hostapis):
        out.append({"index": e["index"], "name": e["name"],
                    "is_default": bool(default_name) and e["name"].lower() == default_name})
    return out


def resolve_input_device(name: "str | None",
                         devices: "list | None" = None,
                         hostapis: object = _SENTINEL) -> "int | None":
    """Índice do device cujo nome casa ``name``, ou ``None`` = **automático** (default do SO).
    ``name`` vazio/``None`` -> ``None``; casa por nome EXATO e depois SUBSTRING; deduplicado com
    a mesma preferência de host API; **fail-safe** (nome ausente -> ``None``, nunca levanta)."""
    if not name or not name.strip():
        return None
    if devices is None:
        try:
            devices = _query_devices()
        except Exception:  # noqa: BLE001
            return None
    if hostapis is _SENTINEL:
        try:
            hostapis = _query_hostapis()
        except Exception:  # noqa: BLE001
            hostapis = None
    target = name.strip().lower()
    inputs = _dedup_inputs(devices, hostapis)
    for e in inputs:                           # 1) match exato
        if e["name"].lower() == target:
            return e["index"]
    for e in inputs:                           # 2) substring
        if target in e["name"].lower():
            return e["index"]
    for e in inputs:                           # 3) nome salvo CHEIO vs enum truncada (MME 31)
        dn = e["name"]
        if len(dn) == _MME_NAME_CAP and target.startswith(dn.lower()):
            return e["index"]
    return None                                # 4) não achou -> automático (fail-safe)
