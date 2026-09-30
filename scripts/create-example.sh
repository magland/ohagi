#!/usr/bin/env bash
# An example shelf with one small paper, for trying the editor.
set -euo pipefail
root="${1:?usage: create-example.sh <dir>}"
files="$root/projects/paper/files"
mkdir -p "$files/figures"
cat > "$files/main.tex" <<'TEX'
\documentclass{article}
\usepackage{amsmath}
\usepackage{graphicx}

\title{An Example Paper}
\author{Alice \and Bob}

\begin{document}
\maketitle

\section{Introduction}
A limitation of most editors is that only one person can type in a file at a
time. Here we describe one where several can.

\section{Method}
The server holds each open file and a version number, and accepts changes
made against any recent version, rebasing them over what came since.
\begin{equation}
  v_{n+1} = v_n + 1.
\end{equation}

\input{results}

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
TEX
cat > "$files/results.tex" <<'TEX'
\section{Results}
Two people typing into one paragraph see each other's text as it is typed.
TEX
cat > "$files/refs.bib" <<'BIB'
@article{example2026,
  author  = {Example, Alice},
  title   = {An example reference},
  journal = {Journal of Examples},
  year    = {2026},
}
BIB
printf '\x89PNG\r\n\x1a\n\0\0\0\rIHDR' > "$files/figures/placeholder.png"
echo "Created $root"
