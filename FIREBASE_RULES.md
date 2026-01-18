# Configuração das Regras do Firebase

Para que os clientes possam acessar suas contas através do link compartilhado, você precisa configurar as regras do Firebase Realtime Database para permitir **leitura pública** dos dados dos clientes.

## ⚠️ Importante
As regras abaixo permitem que qualquer pessoa com o link correto (userId + clientId) possa **ler** os dados do cliente, mas **apenas usuários autenticados** podem escrever/modificar dados.

## 🔧 Como Configurar

1. Acesse o [Firebase Console](https://console.firebase.google.com/)
2. Selecione seu projeto: **vendas-fiadas**
3. Vá em **Realtime Database** → **Regras**
4. Substitua as regras atuais pelas regras abaixo:

```json
{
  "rules": {
    "users": {
      "$userId": {
        ".write": "auth != null && auth.uid == $userId",
        "clients": {
          ".read": true
        }
      }
    }
  }
}
```

## 📝 Explicação das Regras

- `.read: true` - Permite que qualquer pessoa **leia** os dados dos clientes (necessário para os links compartilhados funcionarem)
- `.write: "auth != null && auth.uid == $userId"` - Apenas usuários autenticados podem **escrever/modificar** seus próprios dados
- `$userId` e `$clientId` - Variáveis que representam o ID do usuário e do cliente na URL do banco

## 🔒 Segurança

Embora os dados sejam publicamente legíveis, eles estão protegidos porque:

1. ✅ Os IDs são gerados automaticamente e são praticamente impossíveis de adivinhar
2. ✅ Apenas o dono dos dados pode modificá-los (precisa estar autenticado)
3. ✅ Não há listagem de todos os clientes - é preciso saber o ID exato
4. ✅ Os clientes não podem modificar seus próprios dados, apenas visualizar

## 🧪 Testar

Após aplicar as regras:

1. Faça logout do app principal
2. Acesse um link de cliente compartilhado
3. Você deve conseguir ver os dados sem fazer login
4. Faça login novamente para poder modificar os dados

## 🚨 Regras Alternativas (Mais Restritivas)

Se preferir que apenas usuários autenticados possam ler os dados (sem links públicos):

```json
{
  "rules": {
    "users": {
      "$userId": {
        ".read": "auth != null && auth.uid == $userId",
        ".write": "auth != null && auth.uid == $userId"
      }
    }
  }
}
```

**Nota:** Com essas regras, os links compartilhados NÃO funcionarão, pois os clientes não estarão autenticados.
