{
  description = "Eden development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
    in {
      devShells = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          eden = pkgs.writeShellScriptBin "eden" ''
            if [ -z "''${EDEN_DEV_ROOT:-}" ]; then
              echo "eden: enter the development shell from the Eden checkout first." >&2
              exit 1
            fi

            exec ${pkgs.bun}/bin/bun run "$EDEN_DEV_ROOT/apps/cli/src/main.ts" "$@"
          '';
        in {
          default = pkgs.mkShell {
            packages = [ eden pkgs.bun pkgs.bashInteractive pkgs.zsh pkgs.coreutils ];
            shellHook = ''
              eden_root="$PWD"
              while [ ! -f "$eden_root/apps/cli/src/main.ts" ] && [ "$eden_root" != / ]; do
                eden_root="$(dirname "$eden_root")"
              done

              if [ -f "$eden_root/apps/cli/src/main.ts" ]; then
                export EDEN_DEV_ROOT="$eden_root"
              fi
              unset eden_root
            '';
          };
        });
    };
}
