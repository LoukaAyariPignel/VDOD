"""Lanceur de l'application (double-clic sous Windows, sans console)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from brouilleur.gui import main  # noqa: E402

main()
