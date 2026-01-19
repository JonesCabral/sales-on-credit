# Vivi Variedades - Controle de Vendas

Sistema de controle de vendas fiadas com Firebase.

## Sistema de Controle de Cache

O sistema implementa múltiplas estratégias para garantir que os usuários sempre tenham a versão mais recente:

### 1. Versionamento de Arquivos
- Todos os arquivos CSS e JS incluem parâmetro de versão (`?v=1.8.0`)
- A versão é incrementada a cada atualização significativa

### 2. Cache Busting Automático
- Script no HTML detecta mudança de versão
- Limpa automaticamente caches e service workers
- Força reload quando necessário

### 3. Verificação Periódica de Atualizações
- A cada 5 minutos, verifica se há nova versão disponível
- Notifica o usuário e oferece atualização imediata
- Não interrompe o trabalho do usuário

### 4. Controle de Cache no Servidor (.htaccess)
- HTML: sem cache (sempre atualizado)
- CSS/JS: cache de 1 hora com validação
- Imagens: cache de 30 dias
- Compressão GZIP habilitada

### 5. Manifest PWA
- Permite instalação como aplicativo
- Controle de versão centralizado

## Como Atualizar a Versão

Quando fizer alterações importantes:

1. Atualize a constante `APP_VERSION` em `app.js`
2. Atualize a variável `CURRENT_VERSION` no script de cache em `index.html`
3. Atualize o parâmetro `?v=` nos links de CSS e JS
4. Atualize a versão em `manifest.json`

Exemplo:
```javascript
const APP_VERSION = '1.9.0'; // app.js
const CURRENT_VERSION = '1.9.0'; // index.html
```

```html
<link rel="stylesheet" href="style.css?v=1.9.0">
<script type="module" src="app.js?v=1.9.0"></script>
```

## Tecnologias Utilizadas

- HTML5
- CSS3
- JavaScript (ES6+)
- Firebase (Authentication + Realtime Database)
- PWA (Progressive Web App)

## Funcionalidades

- Autenticação de usuários
- Registro de vendas fiadas
- Controle de pagamentos
- Histórico de transações
- Arquivamento de clientes
- Filtros e busca
- Compartilhamento de histórico
- Anotações de produtos sem preço
- Cálculo automático de débitos/créditos

## Hospedagem

O sistema pode ser hospedado em:
- GitHub Pages
- Firebase Hosting
- Netlify
- Vercel
- Qualquer servidor web com suporte a arquivos estáticos

## Manutenção

Para manter o sistema funcionando perfeitamente:
- Sempre incremente a versão após mudanças
- Teste em diferentes navegadores
- Monitore erros no console
- Verifique compatibilidade mobile

## Versão Atual

**v1.8.0** - Sistema de controle de cache implementado
