// ─────────────────────────────────────────────────────────────────────────────
// phrases.js — Banco de frases pré-definidas organizadas por categoria
//
// ESTRUTURA DE DADOS:
//   categories: Array<Category>
//
//   Category {
//     id      — identificador único (string), usado como chave em localStorage e estado
//     label   — nome exibido na barra de navegação inferior
//     emoji   — ícone da categoria na nav
//     color   — cor de destaque em hex, aplicada via CSS custom property --cat-color
//               usada na borda ativa dos botões de frase e no fundo ativo da nav
//     buttons — Array<Button>
//   }
//
//   Button {
//     label  — texto curto exibido no botão (nome para o histórico e indicador)
//     emoji  — ícone grande centralizado no botão
//     phrase — texto completo falado pelo TTS ao ativar o botão
//              pode ser mais longo e natural do que o label
//   }
//
// CRITÉRIOS DE CURADORIA DAS FRASES:
//   - Prioridade para necessidades básicas e segurança (Essencial, Necessidades, Dor)
//   - Linguagem respeitosa e natural em português brasileiro
//   - Frases curtas o suficiente para serem compreendidas rapidamente
//   - Abrangência sem redundância dentro de cada categoria
//
// EXTENSÃO FUTURA:
//   Novas categorias podem ser adicionadas ao array sem alterar o código do app.
//   A categoria "Favoritos" e "Digitar" são virtuais (geradas em App.jsx) —
//   não constam aqui para separar dados estáticos de lógica dinâmica.
// ─────────────────────────────────────────────────────────────────────────────

export const categories = [
  {
    id: 'essencial',
    label: 'Essencial',
    emoji: '⭐',
    color: '#DC2626',   // vermelho — destaque máximo, acesso rápido ao mais crítico
    buttons: [
      { label: 'Sim',      emoji: '✅', phrase: 'Sim' },
      { label: 'Não',      emoji: '❌', phrase: 'Não' },
      { label: 'Talvez',   emoji: '🤔', phrase: 'Talvez' },
      { label: 'Ajuda',    emoji: '🆘', phrase: 'Preciso de ajuda' },
      { label: 'Dor',      emoji: '😣', phrase: 'Estou com dor' },
      { label: 'Obrigado', emoji: '🙏', phrase: 'Muito obrigado' },
    ],
  },
  {
    id: 'necessidades',
    label: 'Necessidades',
    emoji: '💧',
    color: '#2563EB',   // azul — associado a água, cuidados básicos
    buttons: [
      { label: 'Água',      emoji: '💧', phrase: 'Preciso de água' },
      { label: 'Banheiro',  emoji: '🚽', phrase: 'Preciso ir ao banheiro' },
      { label: 'Comida',    emoji: '🍽️', phrase: 'Estou com fome' },
      { label: 'Remédio',   emoji: '💊', phrase: 'Preciso do meu remédio' },
      { label: 'Descansar', emoji: '😴', phrase: 'Quero descansar' },
      { label: 'Frio',      emoji: '🥶', phrase: 'Estou com frio' },
      { label: 'Calor',     emoji: '🥵', phrase: 'Estou com calor' },
      { label: 'Luz',       emoji: '💡', phrase: 'Pode acender a luz' },
    ],
  },
  {
    id: 'dor',
    label: 'Dor',
    emoji: '🤕',
    color: '#9333EA',   // roxo — cor associada a cuidados médicos/alívio de dor
    buttons: [
      { label: 'Sem dor',   emoji: '😌', phrase: 'Não estou com dor' },
      { label: 'Pouca dor', emoji: '😕', phrase: 'Estou com um pouco de dor' },
      { label: 'Muita dor', emoji: '😭', phrase: 'Estou com muita dor' },
      { label: 'Cabeça',    emoji: '🤯', phrase: 'Minha cabeça está doendo' },
      { label: 'Peito',     emoji: '💔', phrase: 'Estou com dor no peito' },
      { label: 'Barriga',   emoji: '🤢', phrase: 'Minha barriga está doendo' },
      { label: 'Costas',    emoji: '🔙', phrase: 'Minhas costas estão doendo' },
      { label: 'Perna',     emoji: '🦵', phrase: 'Minha perna está doendo' },
    ],
  },
  {
    id: 'sentimentos',
    label: 'Sentimentos',
    emoji: '😊',
    color: '#059669',   // verde — associado a bem-estar emocional
    buttons: [
      { label: 'Bem',       emoji: '😊', phrase: 'Estou me sentindo bem' },
      { label: 'Mal',       emoji: '😔', phrase: 'Não estou me sentindo bem' },
      { label: 'Cansado',   emoji: '😩', phrase: 'Estou muito cansado' },
      { label: 'Com medo',  emoji: '😨', phrase: 'Estou com medo' },
      { label: 'Feliz',     emoji: '😄', phrase: 'Estou feliz' },
      { label: 'Triste',    emoji: '😢', phrase: 'Estou triste' },
      { label: 'Ansioso',   emoji: '😰', phrase: 'Estou ansioso' },
      { label: 'Calmo',     emoji: '😌', phrase: 'Estou calmo' },
    ],
  },
  {
    id: 'pessoas',
    label: 'Pessoas',
    emoji: '👥',
    color: '#D97706',   // laranja-âmbar — tom caloroso, interpessoal
    buttons: [
      { label: 'Médico',     emoji: '👨‍⚕️', phrase: 'Quero falar com o médico' },
      { label: 'Enfermeira', emoji: '👩‍⚕️', phrase: 'Preciso da enfermeira' },
      { label: 'Família',    emoji: '👨‍👩‍👧', phrase: 'Quero ver minha família' },
      { label: 'Sozinho',    emoji: '🧘',  phrase: 'Preciso de um momento sozinho' },
    ],
  },
]
