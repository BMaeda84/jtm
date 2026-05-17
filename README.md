<div align="center">
  <img src="public/logo-wide.svg" width="380" alt="JTM — Comunicação Aumentativa e Alternativa"/>
</div>

<br/>

<div align="center">
  <strong>Em memória de João Tossiro Maeda (30/01/1944 – 21/11/2022)</strong>
</div>

<br/>

<div align="center">

  [![Acesse o app](https://img.shields.io/badge/Acesse%20o%20app-bmaeda84.github.io%2Fjtm-1A4A7A?style=for-the-badge&logo=github)](https://bmaeda84.github.io/jtm/)
  &nbsp;
  [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-apoie%20o%20projeto-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/bmaeda)

</div>

---

## A história

Sou Bruno Maeda, engenheiro de computação especializado em inteligência artificial, funcionário público, casado, paulistano. Não sou desenvolvedor de carreira — construí este projeto com o Claude porque o que precisava fazer estava além do que conseguiria sozinho.

Meu pai, João Tossiro Maeda, sofreu uma série de AVCs que o deixaram internado por mais de 30 dias. Já nos primeiros dias de internação ele havia perdido a fala. Havia uma possibilidade muito remota de sobreviver com sequelas — e, dentro dessas sequelas, estaria a impossibilidade de se comunicar.

Foi durante esse período que imaginei o JTM. Um app simples, acessível pelo celular, que permitisse a ele indicar o que precisava — com um toque, com um olhar, com o que ainda fosse possível. Não tinha experiência suficiente em programação para construí-lo. E então veio a reviravolta: meu pai não se recuperou. Ele faleceu em 21 de novembro de 2022, aos 78 anos, e o projeto ficou para trás junto com a dor daqueles dias.

Depois de algum tempo, experimentando o Claude, percebi que o que antes era inviável por falta de conhecimento técnico agora tinha um caminho real. O JTM voltou — não a tempo de ajudá-lo, mas com a esperança de que possa ajudar outras famílias que estejam vivendo o que eu vivi.

O nome é uma homenagem a ele: **J**oão **T**ossiro **M**aeda.

---

## Acesso

**Sem instalação:** acesse diretamente pelo navegador em **[bmaeda84.github.io/jtm](https://bmaeda84.github.io/jtm/)** — funciona no celular ou tablet, tanto Android quanto iOS.

> Para uso offline (sem internet após o primeiro acesso), adicione à tela inicial: no Chrome/Android toque em "Adicionar à tela inicial"; no Safari/iOS toque no botão Compartilhar → "Adicionar à Tela de Início".

---

## O que é o JTM

O JTM é um PWA (Progressive Web App) de CAA que funciona diretamente no navegador — sem conta, sem instalação, sem custo. O usuário escolhe como quer controlar o app e começa a usar.

### Funcionalidades

| Função | Descrição |
|--------|-----------|
| **Modo Toque** | Toque direto nos botões. Ideal para quem tem alguma mobilidade nas mãos. |
| **Modo Varredura** | Botões acendem em sequência. O usuário seleciona piscando, abrindo a boca ou por tempo automático. |
| **Rastreamento ocular** | O olhar controla um cursor. O usuário olha para o botão e o mantém em foco para ativá-lo. |
| **Síntese de voz offline** | Piper TTS com voz neural em pt-BR. Funciona sem internet após o primeiro carregamento. |
| **Calibração personalizada** | O rastreamento ocular é calibrado sobre o layout real do app — frases e categorias — para máxima precisão. |
| **Filtro de tremor** | One Euro Filter adapta o suavizamento à velocidade do olhar: treme menos em repouso, responde rápido ao movimento intencional. |
| **Detecção de queda** | Detecta quedas pelo acelerômetro e fala automaticamente um pedido de ajuda até ser dispensado. |
| **Alerta de bateria** | Botão extra na categoria Essencial quando a bateria está abaixo de 20%. |

---

## Tecnologias

| Tecnologia | Uso |
|-----------|-----|
| [Vite](https://vitejs.dev/) + [React](https://react.dev/) | Interface e build |
| [MediaPipe FaceLandmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) | Detecção de iris, pálpebras e boca via câmera |
| [One Euro Filter](https://gery.casiez.net/1euro/) | Filtragem adaptativa de tremor no olhar |
| [Piper TTS](https://github.com/rhasspy/piper) | Síntese de voz neural offline em pt-BR |
| Transformada afim (mínimos quadrados) | Calibração olhar → tela |
| [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) | PWA com cache offline |
| GitHub Pages + Actions | Deploy automático a cada push na main |
| CodeQL | Análise estática de segurança (SAST) |

---

## Como rodar

```bash
git clone https://github.com/BMaeda84/jtm.git
cd jtm
npm install
npm run dev
```

> **HTTPS é obrigatório** para câmera e Piper TTS. O servidor de desenvolvimento já usa HTTPS local via `@vitejs/plugin-basic-ssl`. Acesse `https://localhost:3000` (aceite o certificado autoassinado).

Para build de produção:

```bash
npm run build
npm run preview
```

---

## Estrutura do projeto

```
src/
├── App.jsx              # Componente principal: grade de frases, nav, modos de controle
├── App.css              # Estilos base, variáveis CSS de layout e paleta
├── SetupWizard.jsx      # Assistente de configuração: escolha do modo + calibração ocular
├── GazeCursor.jsx       # Cursor de olhar com anel de progresso (dwell selection)
├── phrases.js           # Banco de frases pré-definidas por categoria
├── calibration.js       # Transformada afim por mínimos quadrados + eliminação de Gauss
├── useFaceTracking.js   # Hook: MediaPipe, iris, pálpebras, boca, One Euro Filter
├── useScanning.js       # Hook: lógica de varredura (piscar/boca/auto)
├── useSettings.js       # Hook: configurações persistidas em localStorage
├── useVoice.js          # Hook: seleção e priorização de voz do sistema (TTS nativa)
├── useBattery.js        # Hook: Battery Status API com degradação graciosa
├── useFallDetection.js  # Hook: detecção de queda por acelerômetro (máquina de estados)
├── piperTTS.js          # Piper TTS offline: download, OPFS cache, síntese
└── main.jsx             # Entrada React (createRoot + StrictMode)
```

---

## Próximos passos

- [ ] **Clonagem de voz** — usar uma gravação da voz original da pessoa para síntese personalizada
- [ ] **Grade editável** — permitir que cuidadores customizem frases, categorias e emojis
- [ ] **Persistência na nuvem** — grade e configurações sincronizadas entre dispositivos (Supabase)
- [ ] **Símbolos ARASAAC** — integrar a biblioteca oficial de pictogramas de CAA
- [ ] **Mais idiomas** — vozes e interface em outras línguas
- [x] **Deploy público** — disponível em [bmaeda84.github.io/jtm](https://bmaeda84.github.io/jtm/) sem instalação
- [x] **Modo escuro / alto contraste** — paleta calma com suporte a dark mode

---

## Como contribuir

Contribuições são muito bem-vindas. O JTM é feito por uma pessoa só, com tempo limitado — qualquer ajuda faz diferença.

```bash
# Fork e clone
git clone https://github.com/BMaeda84/jtm.git
cd jtm
npm install

# Crie uma branch
git checkout -b minha-contribuicao

# Faça suas alterações e abra um PR
```

**Áreas que mais precisam de ajuda:**

- **Acessibilidade**: testes com usuários reais de CAA e dispositivos assistivos
- **Eye tracking**: melhorar precisão, testar em diferentes câmeras e iluminações
- **UX / design**: tornar o app mais intuitivo para cuidadores e familiares
- **Testes**: cobertura de testes automatizados está zerada
- **Documentação**: guia de uso, vídeos de demonstração

Abra uma [issue](../../issues) para discutir antes de implementar mudanças grandes.

---

## Apoie o projeto

Se o JTM ajudou alguém a se comunicar, considere apoiar o projeto:

[![Buy Me a Coffee](https://img.shields.io/badge/☕_Buy_Me_a_Coffee-FFDD00?style=flat-square&logoColor=black)](https://buymeacoffee.com/bmaeda)

---

## Licença

MIT © Bruno Maeda — veja [LICENSE](LICENSE).

Este projeto é livre e gratuito. Se ele ajudar alguém a se comunicar, já valeu.
