# Playbook — Publicar uma release

Procedimento reutilizável para cortar uma release nova do projeto.

1. Confirmar que `master`/`main` está verde (build + testes).
2. Subir a versão em todos os manifestos (app + manifestos de pacote).
3. Criar a tag `vX.Y.Z` e fazer push da tag.
4. Confirmar que o CI gerou os artefactos e a Release.
5. Escrever as notas da release: destaques, correções, instruções de atualização.

Notas:
- Nunca commitar segredos; assinar os artefactos quando aplicável.
- Se o build falhar, parar e reportar o erro em vez de continuar.
