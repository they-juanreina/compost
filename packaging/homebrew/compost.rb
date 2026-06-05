# Homebrew formula for compost. Lives in the tap repo they-juanreina/homebrew-tap
# as Formula/compost.rb; kept here in-tree as the source of truth.
#
#   brew tap they-juanreina/tap
#   brew install compost
#
# Bundles the Node CLI. On Apple Silicon, transcription runs natively
# (see docs/transcription.md); Docker/OrbStack is the cross-platform fallback.
class Compost < Formula
  desc "Local-first, AI-first research analysis harness for coding agents and humans"
  homepage "https://github.com/they-juanreina/compost"
  url "https://registry.npmjs.org/@they-juanreina/compost-cli/-/compost-cli-0.1.0.tgz"
  license "MIT"
  version "0.1.0"

  depends_on "node"
  depends_on "ffmpeg"

  def install
    system "npm", "install", *Language::Node.local_npm_install_args, "."
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Transcription runs natively on Apple Silicon (see docs/transcription.md).
      Cross-platform fallback via OrbStack/Docker:
        docker compose -f #{opt_prefix}/transcriber/compose.yaml up -d
        curl http://localhost:7862/health
      Ollama is required for embeddings + local chat:
        brew install ollama && ollama pull bge-m3
    EOS
  end

  test do
    assert_match "0.1.0", shell_output("#{bin}/compost --version")
  end
end
