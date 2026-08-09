
https://jonescabral.github.io/sales-on-credit/


Aviso de pagamento atrasado.

Já pagou alguma vez → dias desde o último pagamento

Nunca pagou → dias desde a primeira venda fiada

## Build dos assets da página do cliente

Os arquivos legíveis são `client-base.css`, `client-view.css` e `client-view.js`.
Depois de alterá-los, gere os arquivos usados em produção com:

```powershell
npx --yes esbuild client-base.css --minify --outfile=client-base.min.css
npx --yes esbuild client-view.css --minify --outfile=client-view.min.css
npx --yes esbuild client-view.js --minify --charset=utf8 --outfile=client-view.min.js
```
