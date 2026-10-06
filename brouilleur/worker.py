"""Processus d'encodage séparé de l'interface.

Usage : python -m brouilleur.worker travail.json
Écrit sur stdout un message JSON par ligne ; lit sur stdin les commandes
« pause », « resume » et « cancel ».
"""

from __future__ import annotations

import json
import sys
import threading
import traceback

from . import pipeline


def main():
    out = sys.stdout
    lock = threading.Lock()

    def emit(msg: dict):
        line = json.dumps(msg, ensure_ascii=False)
        with lock:
            try:
                out.write(line + "\n")
                out.flush()
            except (OSError, ValueError):
                pass

    with open(sys.argv[1], encoding="utf-8") as f:
        job = json.load(f)
    ctl = pipeline.Control()

    def commands():
        for line in sys.stdin:
            cmd = line.strip()
            if cmd == "pause":
                ctl.pause()
                emit({"type": "paused", "paused": True})
            elif cmd == "resume":
                ctl.resume()
                emit({"type": "paused", "paused": False})
            elif cmd == "cancel":
                ctl.cancel()
        # interface fermée : on arrête proprement (les tranches terminées restent)
        if job.get("stop_with_gui"):
            ctl.cancel()

    threading.Thread(target=commands, daemon=True).start()
    try:
        if job.get("type") == "decode":
            from .decoder import DecodeJob
            result = DecodeJob(job, emit, ctl).run()
        else:
            result = pipeline.Encoder(job, emit, ctl).run()
        emit(result)
        code = 0
    except pipeline.Cancelled:
        emit({"type": "cancelled"})
        code = 2
    except pipeline.UserError as e:
        emit({"type": "error", "msg": str(e)})
        code = 1
    except Exception as e:  # noqa: BLE001
        emit({"type": "log", "msg": traceback.format_exc()})
        emit({"type": "error", "msg": friendly_error(e)})
        code = 1
    sys.exit(code)


def friendly_error(e: Exception) -> str:
    s = str(e)
    low = s.lower()
    if "no space left" in low or "espace disque" in low or getattr(e, "errno", None) == 28:
        return "Le disque est plein. Libérez de l'espace puis relancez : l'encodage reprendra où il s'était arrêté."
    if isinstance(e, PermissionError):
        return f"Accès refusé à un fichier : {getattr(e, 'filename', '') or s}. Vérifiez le dossier de destination."
    if isinstance(e, FileNotFoundError):
        return f"Fichier introuvable : {getattr(e, 'filename', '') or s}"
    if "ffmpeg" in low:
        return "La conversion a échoué. Détail : " + s.split(":", 1)[-1].strip() + " (voir le journal détaillé)."
    return f"Erreur inattendue : {s} (voir le journal détaillé)."


if __name__ == "__main__":
    main()
