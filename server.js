const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'SEU_ACCESS_TOKEN_AQUI';
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// 🔑 SUA SENHA SECRETA DE DONO PARA GERAR FICHAS GRÁTIS NO SITE:
const CODIGO_ADMIN = 'ADMIN99';

const usuarios = {
  'jogador1': {
    id: 'jogador1',
    email: 'jogador@email.com',
    criadoEm: Date.now() - (48 * 60 * 60 * 1000),
    fichas: 10, // Já começa com 10 fichas grátis para testar!
    logsUso: []
  }
};

const PACOTES = {
  'pacote_5': { titulo: '5 Fichas Arcade', preco: 5.00, fichasCartao: 5, fichasPix: 6 },
  'pacote_10': { titulo: '10 Fichas Arcade', preco: 10.00, fichasCartao: 10, fichasPix: 12 },
  'pacote_25': { titulo: '25 Fichas Arcade', preco: 25.00, fichasCartao: 25, fichasPix: 30 }
};

app.get('/api/usuario/:id', (req, res) => {
  const user = usuarios[req.params.id];
  if (!user) return res.status(404).json({ erro: 'Usuário não encontrado' });
  res.json({ fichas: user.fichas, logs: user.logsUso });
});

// Rota secreta do Administrador para recarregar fichas grátis
app.post('/api/admin-fichas', (req, res) => {
  const { userId, codigo } = req.body;
  if (codigo !== CODIGO_ADMIN) {
    return res.status(403).json({ erro: 'Código de administrador inválido.' });
  }
  if (usuarios[userId]) {
    usuarios[userId].fichas += 50;
    return res.json({ sucesso: true, fichas: usuarios[userId].fichas });
  }
  res.status(404).json({ erro: 'Usuário não encontrado.' });
});

app.post('/api/comprar', async (req, res) => {
  try {
    const { userId, pacoteId, metodo, aceitouTermos, cpf } = req.body;
    const ipCliente = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!aceitouTermos) {
      return res.status(400).json({ erro: 'Você precisa aceitar os termos de consumo imediato.' });
    }

    const user = usuarios[userId];
    const pacote = PACOTES[pacoteId];
    if (!user || !pacote) return res.status(400).json({ erro: 'Dados inválidos.' });

    const horasDeConta = (Date.now() - user.criadoEm) / (1000 * 60 * 60);
    if (metodo === 'checkout_completo' && horasDeConta < 24 && pacote.preco > 30) {
      return res.status(403).json({ erro: 'Contas novas têm limite de R$ 30 no cartão nas primeiras 24h. Use Pix!' });
    }

    user.logsUso.push({
      evento: 'INICIO_COMPRA',
      pacote: pacoteId,
      metodo,
      cpf: cpf || 'Não informado',
      ip: ipCliente,
      dataHora: new Date().toISOString()
    });

    if (metodo === 'pix') {
      const payment = new Payment(client);
      const result = await payment.create({
        body: {
          transaction_amount: pacote.preco,
          description: `${pacote.titulo} (+Bônus Pix)`,
          payment_method_id: 'pix',
          payer: {
            email: user.email,
            identification: { type: 'CPF', number: cpf.replace(/\D/g, '') }
          },
          metadata: { user_id: userId, fichas: pacote.fichasPix, ip: ipCliente }
        }
      });

      return res.json({
        tipo: 'pix',
        qr_code: result.point_of_interaction.transaction_data.qr_code,
        qr_code_base64: result.point_of_interaction.transaction_data.qr_code_base64,
        payment_id: result.id
      });
    }

    const preference = new Preference(client);
    const prefResult = await preference.create({
      body: {
        items: [{
          title: pacote.titulo,
          quantity: 1,
          unit_price: pacote.preco,
          currency_id: 'BRL'
        }],
        payer: { email: user.email },
        metadata: { user_id: userId, fichas: pacote.fichasCartao, ip: ipCliente },
        back_urls: {
          success: `${req.protocol}://${req.get('host')}/?status=aprovado`,
          failure: `${req.protocol}://${req.get('host')}/?status=falha`
        },
        auto_return: 'approved'
      }
    });

    res.json({ tipo: 'link', init_point: prefResult.init_point });

  } catch (error) {
    console.error(error);
    res.status(500).json({ erro: 'Erro ao gerar pagamento no Mercado Pago.' });
  }
});

app.post('/api/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type === 'payment' && data?.id) {
      const payment = new Payment(client);
      const info = await payment.get({ id: data.id });

      if (info.status === 'approved') {
        const { user_id, fichas, ip } = info.metadata;
        if (usuarios[user_id]) {
          usuarios[user_id].fichas += Number(fichas);
          usuarios[user_id].logsUso.push({
            evento: 'PAGAMENTO_APROVADO',
            paymentId: data.id,
            metodo: info.payment_method_id,
            fichasCreditadas: fichas,
            ipOrigem: ip,
            dataHora: new Date().toISOString()
          });
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(500);
  }
});

app.post('/api/inserir-ficha', (req, res) => {
  const { userId, jogo } = req.body;
  const ipCliente = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const user = usuarios[userId];

  if (!user || user.fichas <= 0) {
    return res.status(400).json({ erro: 'Saldo insuficiente. Compre mais fichas!' });
  }

  user.fichas -= 1;

  user.logsUso.push({
    evento: 'FICHA_CONSUMIDA_NO_JOGO',
    jogoSelecionado: jogo,
    ipNoMomentoDoJogo: ipCliente,
    userAgent: req.headers['user-agent'],
    dataHora: new Date().toISOString()
  });

  res.json({ sucesso: true, fichasRestantes: user.fichas });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fliperama rodando na porta ${PORT}`));

