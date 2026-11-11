//! Script de build de la coque : prépare le contexte Tauri, et grave dans le
//! binaire de quoi démarrer le daemon sans rien hériter du shell.
//!
//! Une application lancée d'un double-clic (Finder, explorateur Windows)
//! **n'hérite pas du `PATH` du terminal** : elle ne trouverait pas `node`. Le
//! build se fait par `npm run desktop:build`, et npm donne le chemin exact de
//! son `node` dans `npm_node_execpath` : c'est lui qu'on retient, avec la
//! racine du clone, déduite de l'emplacement de ce fichier. Au lancement, les
//! variables `MIDGAARD_NODE` et `MIDGAARD_REPO` passent devant.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    // apps/desktop/src-tauri → racine du clone.
    let repo = manifest
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .expect("racine du clone introuvable");
    println!("cargo:rustc-env=MIDGAARD_REPO_BUILD={}", plain(repo));

    let node = std::env::var("npm_node_execpath")
        .or_else(|_| std::env::var("NODE"))
        .unwrap_or_default();
    println!("cargo:rustc-env=MIDGAARD_NODE_BUILD={node}");
    println!("cargo:rerun-if-env-changed=npm_node_execpath");
    println!("cargo:rerun-if-env-changed=NODE");

    embed_runtime(&manifest);

    tauri_build::build()
}

/// Pour l'exécutable unique (`--features portable`) : copie l'archive de
/// l'arbre embarqué là où `include_bytes!` la lit, et grave une empreinte de
/// son contenu. L'empreinte nomme le dossier où l'archive se déplie : une
/// nouvelle version se déplie à côté de l'ancienne, jamais par-dessus un
/// daemon qui tourne encore.
fn embed_runtime(manifest: &std::path::Path) {
    println!("cargo:rerun-if-env-changed=MIDGAARD_RUNTIME_ARCHIVE");
    if std::env::var("CARGO_FEATURE_PORTABLE").is_err() {
        return;
    }
    let archive = std::env::var("MIDGAARD_RUNTIME_ARCHIVE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest.join("runtime.tar.gz"));
    println!("cargo:rerun-if-changed={}", archive.display());
    let bytes = std::fs::read(&archive).unwrap_or_else(|e| {
        panic!(
            "exécutable unique : {} illisible ({e}) — construire par `npm run desktop:portable`",
            archive.display()
        )
    });
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(out.join("runtime.tar.gz"), &bytes).expect("copie de l'archive");
    // FNV-1a 64 bits : écrit ici pour que l'empreinte ne dépende ni d'une
    // dépendance ni de la version de Rust. Ce n'est pas une preuve
    // d'intégrité, seulement un nom de dossier stable pour un contenu donné.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in &bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    println!("cargo:rustc-env=MIDGAARD_RUNTIME_STAMP={hash:016x}-{}", bytes.len());
}

/// Un chemin sans le préfixe `\\?\` que `canonicalize` ajoute sous Windows :
/// passé tel quel à `node`, il ne désigne pas le fichier attendu.
fn plain(path: PathBuf) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(text)
}
