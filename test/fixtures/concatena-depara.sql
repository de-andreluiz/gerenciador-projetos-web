-- Cópia de teste do script "CONCATENA DE-PARA ENTRE BASES" (usado pelo scripts/e2e-local.js).
-- Igual ao original, exceto: destino = '{{BANCO}}', origens = {{ORIGEM_1}}/{{ORIGEM_2}} e a lista de tabelas.
SET NOCOUNT ON;

DECLARE @BancoDestino SYSNAME = '{{BANCO}}';
DECLARE @Schema       SYSNAME = 'dbo';


/*==================================================================================================
    BANCOS DE ORIGEM
==================================================================================================*/

DECLARE @Bancos TABLE
(
    Id      INT IDENTITY(1,1),
    Banco   SYSNAME
);

INSERT INTO @Bancos (Banco)
VALUES
    ('{{ORIGEM_1}}'),
    ('{{ORIGEM_2}}');


/*==================================================================================================
    TABELAS A SEREM CONCATENADAS
==================================================================================================*/

DECLARE @Tabelas TABLE
(
    Id      INT IDENTITY(1,1),
    Tabela  SYSNAME
);

INSERT INTO @Tabelas (Tabela)
VALUES
    ('ZDEPARA_BANCOS'),
    ('ZDEPARA_SITUACAO'),
    ('ZDEPARA_INEXISTENTE');


/*==================================================================================================
    VARIÁVEIS
==================================================================================================*/

DECLARE
    @Tabela         SYSNAME,
    @Banco          SYSNAME,
    @BancoBase      SYSNAME,
    @SQL            NVARCHAR(MAX),
    @SQLUnion       NVARCHAR(MAX),
    @Colunas        NVARCHAR(MAX),
    @TemIdentity    BIT,
    @TemTabela      BIT;


/*==================================================================================================
    PROCESSAMENTO DAS TABELAS
==================================================================================================*/

DECLARE CursorTabelas CURSOR LOCAL FAST_FORWARD
FOR
    SELECT Tabela
    FROM @Tabelas
    ORDER BY Id;

OPEN CursorTabelas;

FETCH NEXT FROM CursorTabelas
INTO @Tabela;

WHILE @@FETCH_STATUS = 0
BEGIN

    PRINT '===============================================================================';
    PRINT 'PROCESSANDO: ' + @Tabela;
    PRINT '===============================================================================';


    BEGIN TRY

        /*==========================================================================================
            1. PROCURA A PRIMEIRA BASE QUE POSSUI A TABELA

            Não depende mais do ABRASIL.
        ==========================================================================================*/

        SET @BancoBase = NULL;
        SET @TemTabela = 0;

        DECLARE CursorBuscaBase CURSOR LOCAL FAST_FORWARD
        FOR
            SELECT Banco
            FROM @Bancos
            ORDER BY Id;

        OPEN CursorBuscaBase;

        FETCH NEXT FROM CursorBuscaBase
        INTO @Banco;

        WHILE @@FETCH_STATUS = 0
        BEGIN

            SET @SQL = N'
                IF EXISTS
                (
                    SELECT 1
                    FROM ' + QUOTENAME(@Banco) + N'.sys.tables T
                    INNER JOIN ' + QUOTENAME(@Banco) + N'.sys.schemas S
                        ON S.schema_id = T.schema_id
                    WHERE T.name = @Tabela
                      AND S.name = @Schema
                )
                BEGIN
                    SET @Encontrou = 1;
                END;
            ';

            DECLARE @Encontrou BIT = 0;

            EXEC sys.sp_executesql
                @SQL,
                N'@Tabela SYSNAME, @Schema SYSNAME, @Encontrou BIT OUTPUT',
                @Tabela = @Tabela,
                @Schema = @Schema,
                @Encontrou = @Encontrou OUTPUT;

            IF @Encontrou = 1
            BEGIN
                SET @BancoBase = @Banco;
                SET @TemTabela = 1;
                BREAK;
            END;

            FETCH NEXT FROM CursorBuscaBase
            INTO @Banco;

        END;

        CLOSE CursorBuscaBase;
        DEALLOCATE CursorBuscaBase;


        /*==========================================================================================
            2. SE NENHUMA BASE POSSUI A TABELA, IGNORA
        ==========================================================================================*/

        IF @TemTabela = 0
        BEGIN

            PRINT 'ATENÇÃO: Tabela não encontrada em nenhuma base: ' + @Tabela;
            PRINT 'IGNORADA: ' + @Tabela;
            PRINT '';

            FETCH NEXT FROM CursorTabelas
            INTO @Tabela;

            CONTINUE;

        END;


        PRINT 'Base utilizada para estrutura: ' + @BancoBase;


        /*==========================================================================================
            3. REMOVE A TABELA DO DESTINO
        ==========================================================================================*/

        SET @SQL = N'
            IF OBJECT_ID(
                N''' + @Schema + N'.' + @Tabela + N''',
                N''U''
            ) IS NOT NULL
            BEGIN
                DROP TABLE '
                + QUOTENAME(@BancoDestino)
                + N'.'
                + QUOTENAME(@Schema)
                + N'.'
                + QUOTENAME(@Tabela)
                + N';
            END;
        ';

        EXEC sys.sp_executesql @SQL;


        /*==========================================================================================
            4. CRIA A ESTRUTURA A PARTIR DA PRIMEIRA BASE QUE POSSUI A TABELA

            TOP 0 = somente estrutura, sem dados.
        ==========================================================================================*/

        SET @SQL = N'
            SELECT TOP 0 *
            INTO '
            + QUOTENAME(@BancoDestino)
            + N'.'
            + QUOTENAME(@Schema)
            + N'.'
            + QUOTENAME(@Tabela)
            + N'
            FROM '
            + QUOTENAME(@BancoBase)
            + N'.'
            + QUOTENAME(@Schema)
            + N'.'
            + QUOTENAME(@Tabela)
            + N';
        ';

        EXEC sys.sp_executesql @SQL;


        /*==========================================================================================
            5. DESCOBRE AS COLUNAS DA TABELA DESTINO
        ==========================================================================================*/

        SET @Colunas = NULL;
        SET @TemIdentity = 0;

        SET @SQL = N'
            SELECT
                @Colunas = STRING_AGG(
                    CAST(QUOTENAME(C.name) AS NVARCHAR(MAX)),
                    N'', ''
                ) WITHIN GROUP (
                    ORDER BY C.column_id
                ),

                @TemIdentity =
                    CONVERT(
                        BIT,
                        MAX(
                            CASE
                                WHEN C.is_identity = 1 THEN 1
                                ELSE 0
                            END
                        )
                    )

            FROM ' + QUOTENAME(@BancoDestino) + N'.sys.columns C

            INNER JOIN ' + QUOTENAME(@BancoDestino) + N'.sys.tables T
                ON T.object_id = C.object_id

            INNER JOIN ' + QUOTENAME(@BancoDestino) + N'.sys.schemas S
                ON S.schema_id = T.schema_id

            WHERE T.name = @Tabela
              AND S.name = @Schema;
        ';

        EXEC sys.sp_executesql
            @SQL,
            N'
                @Tabela SYSNAME,
                @Schema SYSNAME,
                @Colunas NVARCHAR(MAX) OUTPUT,
                @TemIdentity BIT OUTPUT
            ',
            @Tabela = @Tabela,
            @Schema = @Schema,
            @Colunas = @Colunas OUTPUT,
            @TemIdentity = @TemIdentity OUTPUT;


        /*==========================================================================================
            6. MONTA O UNION ALL SOMENTE COM AS BASES QUE POSSUEM A TABELA

            Depois o SELECT DISTINCT elimina duplicidades.
        ==========================================================================================*/

        SET @SQLUnion = NULL;

        DECLARE CursorBancos CURSOR LOCAL FAST_FORWARD
        FOR
            SELECT Banco
            FROM @Bancos
            ORDER BY Id;

        OPEN CursorBancos;

        FETCH NEXT FROM CursorBancos
        INTO @Banco;

        WHILE @@FETCH_STATUS = 0
        BEGIN

            SET @SQL = N'
                IF EXISTS
                (
                    SELECT 1
                    FROM ' + QUOTENAME(@Banco) + N'.sys.tables T
                    INNER JOIN ' + QUOTENAME(@Banco) + N'.sys.schemas S
                        ON S.schema_id = T.schema_id
                    WHERE T.name = @Tabela
                      AND S.name = @Schema
                )
                BEGIN

                    SET @SQLUnion =
                        ISNULL(@SQLUnion + N'' UNION ALL '', N'''') +
                        N''SELECT ''
                        + @Colunas
                        + N'' FROM ''
                        + QUOTENAME(@Banco)
                        + N''.''
                        + QUOTENAME(@Schema)
                        + N''.''
                        + QUOTENAME(@Tabela);

                END;
            ';

            EXEC sys.sp_executesql
                @SQL,
                N'
                    @Banco SYSNAME,
                    @Tabela SYSNAME,
                    @Schema SYSNAME,
                    @Colunas NVARCHAR(MAX),
                    @SQLUnion NVARCHAR(MAX) OUTPUT
                ',
                @Banco = @Banco,
                @Tabela = @Tabela,
                @Schema = @Schema,
                @Colunas = @Colunas,
                @SQLUnion = @SQLUnion OUTPUT;

            FETCH NEXT FROM CursorBancos
            INTO @Banco;

        END;

        CLOSE CursorBancos;
        DEALLOCATE CursorBancos;


        /*==========================================================================================
            7. INSERE OS DADOS COM DISTINCT

            UNION ALL junta tudo.
            SELECT DISTINCT remove registros completamente iguais.
        ==========================================================================================*/

        IF @TemIdentity = 1
        BEGIN
            SET @SQL = N'
                SET IDENTITY_INSERT '
                + QUOTENAME(@BancoDestino)
                + N'.'
                + QUOTENAME(@Schema)
                + N'.'
                + QUOTENAME(@Tabela)
                + N' ON;
            ';
        END
        ELSE
        BEGIN
            SET @SQL = N'';
        END;


        SET @SQL += N'

            INSERT INTO '
            + QUOTENAME(@BancoDestino)
            + N'.'
            + QUOTENAME(@Schema)
            + N'.'
            + QUOTENAME(@Tabela)
            + N'
            (
                ' + @Colunas + N'
            )

            SELECT DISTINCT
                ' + @Colunas + N'

            FROM
            (
                ' + @SQLUnion + N'
            ) AS Dados;
        ';


        IF @TemIdentity = 1
        BEGIN
            SET @SQL += N'
                SET IDENTITY_INSERT '
                + QUOTENAME(@BancoDestino)
                + N'.'
                + QUOTENAME(@Schema)
                + N'.'
                + QUOTENAME(@Tabela)
                + N' OFF;
            ';
        END;


        EXEC sys.sp_executesql @SQL;


        /*==========================================================================================
            8. MOSTRA QUAIS BASES POSSUEM A TABELA
        ==========================================================================================*/

        DECLARE CursorLog CURSOR LOCAL FAST_FORWARD
        FOR
            SELECT Banco
            FROM @Bancos
            ORDER BY Id;

        OPEN CursorLog;

        FETCH NEXT FROM CursorLog
        INTO @Banco;

        WHILE @@FETCH_STATUS = 0
        BEGIN

            SET @SQL = N'
                IF EXISTS
                (
                    SELECT 1
                    FROM ' + QUOTENAME(@Banco) + N'.sys.tables T
                    INNER JOIN ' + QUOTENAME(@Banco) + N'.sys.schemas S
                        ON S.schema_id = T.schema_id
                    WHERE T.name = @Tabela
                      AND S.name = @Schema
                )
                BEGIN
                    PRINT ''Copiado: ' + REPLACE(@Banco, '''', '''''') + N''';
                END
                ELSE
                BEGIN
                    PRINT ''Ignorado - tabela inexistente: ' + REPLACE(@Banco, '''', '''''') + N''';
                END;
            ';

            EXEC sys.sp_executesql
                @SQL,
                N'@Tabela SYSNAME, @Schema SYSNAME',
                @Tabela = @Tabela,
                @Schema = @Schema;

            FETCH NEXT FROM CursorLog
            INTO @Banco;

        END;

        CLOSE CursorLog;
        DEALLOCATE CursorLog;


        PRINT 'FINALIZADO COM SUCESSO: ' + @Tabela;
        PRINT '';


    END TRY

    BEGIN CATCH

        PRINT 'ERRO AO PROCESSAR: ' + @Tabela;
        PRINT 'Mensagem: ' + ERROR_MESSAGE();
        PRINT 'Linha: ' + CAST(ERROR_LINE() AS VARCHAR(20));
        PRINT '';

    END CATCH;


    FETCH NEXT FROM CursorTabelas
    INTO @Tabela;

END;


CLOSE CursorTabelas;
DEALLOCATE CursorTabelas;


/*==================================================================================================
    VALIDAÇÃO FINAL
==================================================================================================*/

SET @SQL = N'';

SELECT @SQL =
    STRING_AGG(
        CAST(
            N'
            IF OBJECT_ID(
                N''' + @Schema + N'.' + Tabela + N''',
                N''U''
            ) IS NOT NULL
            BEGIN
                SELECT
                    N''' + REPLACE(Tabela, '''', '''''') + N''' AS TABELA,
                    COUNT_BIG(*) AS TOTAL
                FROM '
                + QUOTENAME(@BancoDestino)
                + N'.'
                + QUOTENAME(@Schema)
                + N'.'
                + QUOTENAME(Tabela)
                + N';
            END
            '
            AS NVARCHAR(MAX)
        ),
        N'
        '
    )
FROM @Tabelas;

IF @SQL IS NOT NULL
BEGIN
    EXEC sys.sp_executesql @SQL;
END;