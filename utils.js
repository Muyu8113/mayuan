// --- START OF FILE utils.js ---

// LocalStorage 的辅助函数
const WRONG_SET_KEY = 'marxism_wrong_set';
const PROGRESS_KEY_PREFIX = 'marxism_progress_'; // 为进度保存添加前缀
const TEST_HISTORY_KEY = 'marxism_test_history'; // 新增：为测试历史记录添加键

function getWrongSet() {
    try {
        const data = localStorage.getItem(WRONG_SET_KEY);
        if (!data) return [];
        const parsedData = JSON.parse(data);
        return parsedData.map(item => (Array.isArray(item) ? {question: item, consecutiveCorrect: 0} : item));
    } catch (e) {
        console.error("无法从 localStorage 解析错题集", e);
        return [];
    }
}

function saveWrongSet(set) {
    localStorage.setItem(WRONG_SET_KEY, JSON.stringify(set));
    document.dispatchEvent(new CustomEvent('wrongset-updated'));
}

function addQuestionToWrongSet(originalQuestionArray) {
    const wrongSet = getWrongSet();
    const questionText = originalQuestionArray[0];
    const itemIndex = wrongSet.findIndex(item => item.question[0] === questionText);

    if (itemIndex === -1) {
        wrongSet.push({question: originalQuestionArray, consecutiveCorrect: 0});
    } else {
        wrongSet[itemIndex].consecutiveCorrect = 0;
    }
    saveWrongSet(wrongSet);
}


function parseQuestion(qArray) {
    if (!Array.isArray(qArray) || qArray.length < 2) return null;
    const cleanArray = qArray.filter(item => typeof item === 'string' && item.trim() !== '');
    if (cleanArray.length < 2) return null;

    const answerLine = cleanArray.find(line => line.startsWith('正确答案:'));
    if (!answerLine) return null;
    const answerIndex = cleanArray.indexOf(answerLine);
    let correctAnswer = answerLine.split(':')[1]?.trim();
    if (!correctAnswer) return null;

    const mainQuestionLine = cleanArray[0];
    let type;
    if (/[（(]判断题[)）]/.test(mainQuestionLine)) {
        type = 'judge';
    } else if (/[（(]多选题[)）]/.test(mainQuestionLine)) {
        type = 'multiple';
    } else {
        type = 'single';
    }

    let question;
    let options;

    if (type === 'judge') {
        question = mainQuestionLine;
        options = ['A. 对', 'B. 错'];
        if (correctAnswer === '对') correctAnswer = 'A';
        if (correctAnswer === '错') correctAnswer = 'B';
    } else {
        const firstOptionIndex = cleanArray.findIndex(line => /^[A-Z]\./.test(line.trim()));

        if (firstOptionIndex === -1 || firstOptionIndex >= answerIndex) {
            return null;
        }

        const questionLines = cleanArray.slice(0, firstOptionIndex);
        question = questionLines.join('\n'); // Join with newline for multi-line display
        options = cleanArray.slice(firstOptionIndex, answerIndex);
    }

    if (options.length === 0) return null;

    return {
        question: question,
        options: options,
        type: type,
        correctAnswer: correctAnswer,
        originalData: qArray
    };
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function createBrushLogic(isWrongSetMode = false) {
    // 根据是否为错题模式，创建唯一的模式标识符
    const modeIdentifier = isWrongSetMode ? 'wrong_' : 'normal_';
    return {
        allQuestions: [],
        practicePool: [],
        currentQuestionIndex: -1,
        currentQuestion: null,
        userSelection: null,
        isPracticeStarted: false,
        isAnswerChecked: false,
        isCorrect: false,
        stats: {correct: 0, incorrect: 0, total: 0},
        autoNextTimeout: null,
        counts: {single: 0, multiple: 0, judge: 0, total: 0},
        isEmpty: true,
        answerHistory: {},
        practiceType: null,

        hasSavedProgress(type) {
            // 使用包含模式标识符的键来检查进度
            return localStorage.getItem(PROGRESS_KEY_PREFIX + modeIdentifier + type) !== null;
        },

        saveProgress() {
            if (!this.isPracticeStarted || !this.practiceType || this.currentQuestion === null) return;
            const state = {
                practicePool: this.practicePool,
                currentQuestionIndex: this.currentQuestionIndex,
                stats: this.stats,
                answerHistory: this.answerHistory,
            };
            // 使用包含模式标识符的键来保存进度
            localStorage.setItem(PROGRESS_KEY_PREFIX + modeIdentifier + this.practiceType, JSON.stringify(state));
        },

        clearProgress(type = null) {
            const progressType = type || this.practiceType;
            if (progressType) {
                // 使用包含模式标识符的键来清除进度
                localStorage.removeItem(PROGRESS_KEY_PREFIX + modeIdentifier + progressType);
            }
        },

        continuePractice(type) {
            // 使用包含模式标识符的键来加载进度
            const savedState = JSON.parse(localStorage.getItem(PROGRESS_KEY_PREFIX + modeIdentifier + type));
            if (!savedState) return;

            this.practicePool = savedState.practicePool;
            this.stats = savedState.stats;
            this.answerHistory = savedState.answerHistory;
            this.isPracticeStarted = true;
            this.practiceType = type;
            this.loadQuestion(savedState.currentQuestionIndex);
        },

        get displayQuestionText() {
            if (!this.currentQuestion) return '';
            const questionWithoutOldNumber = this.currentQuestion.question.replace(/^\d+\.\s*/, '');
            return `${this.currentQuestionIndex + 1}. ${questionWithoutOldNumber}`;
        },

        get sectionTitle() {
            if (!this.currentQuestion) return '';
            switch (this.currentQuestion.type) {
                case 'single':
                    return '--- 单选题 ---';
                case 'multiple':
                    return '--- 多选题 ---';
                case 'judge':
                    return '--- 判断题 ---';
                default:
                    return '';
            }
        },

        init(allParsedQuestions = null) {
            this.allQuestions = allParsedQuestions || [];
            if (isWrongSetMode) {
                this.checkWrongSetCounts();
            }
        },

        reset() {
            if (this.autoNextTimeout) clearTimeout(this.autoNextTimeout);
            this.isPracticeStarted = false;
            this.currentQuestion = null;
            this.answerHistory = {};
            this.practiceType = null;
            if (isWrongSetMode) {
                this.checkWrongSetCounts();
            }
        },

        checkWrongSetCounts() {
            if (!isWrongSetMode) return;
            const wrongSet = getWrongSet().map(item => parseQuestion(item.question)).filter(q => q !== null);
            this.allQuestions = wrongSet;
            this.counts.single = wrongSet.filter(q => q.type === 'single').length;
            this.counts.multiple = wrongSet.filter(q => q.type === 'multiple').length;
            this.counts.judge = wrongSet.filter(q => q.type === 'judge').length;
            this.counts.total = wrongSet.length;
            this.isEmpty = this.counts.total === 0;
        },

        startPracticeByType(type) {
            this.clearProgress(type);
            this.practiceType = type;
            let source = this.allQuestions;
            if (type === 'all') {
                const singles = source.filter(q => q.type === 'single');
                const multiples = source.filter(q => q.type === 'multiple');
                const judges = source.filter(q => q.type === 'judge');
                this.practicePool = [...shuffleArray(singles), ...shuffleArray(multiples), ...shuffleArray(judges)];
            } else {
                this.practicePool = shuffleArray(source.filter(q => q.type === type));
            }
            this.stats.total = this.practicePool.length;
            if (this.stats.total > 0) this.startPractice();
        },

        startPractice() {
            this.isPracticeStarted = true;
            this.currentQuestionIndex = -1;
            this.stats.correct = 0;
            this.stats.incorrect = 0;
            this.answerHistory = {};
            this.loadQuestion(0);
        },

        loadQuestion(index) {
            if (this.autoNextTimeout) clearTimeout(this.autoNextTimeout);

            // 优先重置与答案相关的状态
            this.isAnswerChecked = false;
            this.isCorrect = false;

            this.currentQuestionIndex = index;
            if (index < 0 || index >= this.practicePool.length) {
                this.currentQuestion = null;
                this.clearProgress();
                return;
            }

            this.currentQuestion = this.practicePool[index];
            // 重置用户选择
            this.userSelection = this.currentQuestion.type === 'multiple' ? [] : '';

            const history = this.answerHistory[index];
            if (history) {
                // 如果有历史记录，则恢复状态
                this.isAnswerChecked = true;
                this.isCorrect = history.isCorrect;
                this.userSelection = history.userSelection;
            }

            this.saveProgress();
        },

        prevQuestion() {
            if (this.currentQuestionIndex > 0) {
                this.loadQuestion(this.currentQuestionIndex - 1);
            }
        },

        nextQuestion() {
            if (this.currentQuestionIndex >= this.practicePool.length - 1) {
                this.currentQuestion = null;
                this.clearProgress();
            } else {
                this.loadQuestion(this.currentQuestionIndex + 1);
            }
        },

        selectAndCheck(selection) {
            if (this.isAnswerChecked) return;
            this.userSelection = selection;
            this.checkAnswer(true);
        },

        checkAnswer(isAutoCheck = false) {
            if (!this.currentQuestion || this.isAnswerChecked) return;
            if (this.currentQuestion.type === 'multiple' && this.userSelection.length === 0) {
                alert('请选择答案。');
                return;
            }
            this.isAnswerChecked = true;
            let isCorrect;
            if (this.currentQuestion.type === 'multiple') {
                const userAnswerSorted = this.userSelection.sort().join('');
                const correctAnswerSorted = [...this.currentQuestion.correctAnswer].sort().join('');
                isCorrect = userAnswerSorted === correctAnswerSorted;
            } else {
                isCorrect = this.userSelection === this.currentQuestion.correctAnswer;
            }
            this.isCorrect = isCorrect;

            if (!this.answerHistory[this.currentQuestionIndex]) {
                if (isCorrect) this.stats.correct++; else this.stats.incorrect++;
                if (!isWrongSetMode && !isCorrect) addQuestionToWrongSet(this.currentQuestion.originalData);
            }

            if (isWrongSetMode && this.answerHistory[this.currentQuestionIndex]?.isCorrect !== true && isCorrect) {
                const wrongSet = getWrongSet();
                const itemIndex = wrongSet.findIndex(item => item.question[0] === this.currentQuestion.question);
                if (itemIndex > -1) {
                    wrongSet[itemIndex].consecutiveCorrect = (wrongSet[itemIndex].consecutiveCorrect || 0) + 1;
                    if (wrongSet[itemIndex].consecutiveCorrect >= 3) {
                        wrongSet.splice(itemIndex, 1);
                    }
                    saveWrongSet(wrongSet);
                }
            } else if (isWrongSetMode && !isCorrect) {
                const wrongSet = getWrongSet();
                const itemIndex = wrongSet.findIndex(item => item.question[0] === this.currentQuestion.question);
                if (itemIndex > -1) {
                    wrongSet[itemIndex].consecutiveCorrect = 0;
                    saveWrongSet(wrongSet);
                }
            }

            this.answerHistory[this.currentQuestionIndex] = {
                userSelection: this.userSelection,
                isCorrect: this.isCorrect
            };

            this.saveProgress();

            if (isAutoCheck && this.currentQuestion.type !== 'multiple' && this.isCorrect) {
                this.autoNextTimeout = setTimeout(() => this.nextQuestion(), 1200);
            }
        },

        getOptionClass(option) {
            if (!this.currentQuestion || !this.isAnswerChecked) return '';
            const optionChar = option.charAt(0);
            const isCorrectAnswer = this.currentQuestion.correctAnswer.includes(optionChar);
            let isSelected = false;
            if (this.currentQuestion.type === 'multiple') {
                isSelected = this.userSelection.includes(optionChar);
            } else {
                isSelected = this.userSelection === optionChar;
            }
            if (isCorrectAnswer) return 'option-label-correct';
            if (isSelected && !isCorrectAnswer) return 'option-label-incorrect';
            return '';
        },
    }
}

// --- 模拟测试逻辑 (已更新) ---
function createTestLogic() {
    return {
        allQuestions: [],
        practicePool: [],
        currentQuestionIndex: -1,
        currentQuestion: null,
        userSelection: null,
        isPracticeStarted: false,
        isAnswerChecked: false,
        isCorrect: false,
        stats: {correct: 0, incorrect: 0, total: 100}, // total is fixed at 100
        answerHistory: {},
        history: [],
        timerInterval: null,
        startTime: 0,
        elapsedTime: 0,
        formattedTime: '00:00',
        lastTestResult: null,
        autoNextTimeout: null,

        init(allParsedQuestions) {
            this.allQuestions = allParsedQuestions;
            this.loadHistory();
        },

        loadHistory() {
            const data = localStorage.getItem(TEST_HISTORY_KEY);
            this.history = data ? JSON.parse(data) : [];
        },

        saveHistory() {
            localStorage.setItem(TEST_HISTORY_KEY, JSON.stringify(this.history));
        },

        startTimer() {
            this.startTime = Date.now() - this.elapsedTime;
            this.timerInterval = setInterval(() => {
                this.elapsedTime = Date.now() - this.startTime;
                this.formattedTime = this.formatDuration(this.elapsedTime / 1000);
            }, 1000);
        },

        stopTimer() {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
        },

        formatDuration(seconds) {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            const pad = (num) => num.toString().padStart(2, '0');
            if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
            return `${pad(m)}:${pad(s)}`;
        },

        reset() {
            this.stopTimer();
            if (this.autoNextTimeout) clearTimeout(this.autoNextTimeout);
            this.isPracticeStarted = false;
            this.currentQuestion = null;
            this.answerHistory = {};
            this.lastTestResult = null;
            this.loadHistory();
        },

        startTest() {
            const counts = {single: 50, multiple: 30, judge: 20};
            this.stats.total = counts.single + counts.multiple + counts.judge;
            const singles = shuffleArray(this.allQuestions.filter(q => q.type === 'single')).slice(0, counts.single);
            const multiples = shuffleArray(this.allQuestions.filter(q => q.type === 'multiple')).slice(0, counts.multiple);
            const judges = shuffleArray(this.allQuestions.filter(q => q.type === 'judge')).slice(0, counts.judge);

            this.practicePool = [...singles, ...multiples, ...judges];
            // Ensure total matches the actual pool size if source is insufficient
            this.stats.total = this.practicePool.length;

            if (this.stats.total === 0) {
                alert("题库为空，无法开始测试！");
                return;
            }

            this.isPracticeStarted = true;
            this.currentQuestionIndex = -1;
            this.stats.correct = 0;
            this.stats.incorrect = 0;
            this.answerHistory = {};
            this.elapsedTime = 0;
            this.formattedTime = '00:00';
            this.startTimer();
            this.loadQuestion(0);
        },

        finishTest() {
            this.stopTimer();
            this.currentQuestion = null;

            // --- 这是本次修改的核心 ---
            const answeredCount = Object.keys(this.answerHistory).length;
            const accuracy = answeredCount > 0
                ? ((this.stats.correct / answeredCount) * 100).toFixed(2) + '%'
                : '0.00%';

            const result = {
                id: Date.now(),
                date: new Date().toLocaleString(),
                stats: {...this.stats},
                answeredCount: answeredCount, // 新增：记录实际答题数
                duration: this.elapsedTime,
                formattedDuration: this.formatDuration(this.elapsedTime / 1000),
                accuracy: accuracy
            };
            // --- 修改结束 ---

            this.lastTestResult = result;
            this.history.unshift(result);
            this.saveHistory();
        },

        isLastQuestion() {
            return this.currentQuestionIndex === this.practicePool.length - 1;
        },

        get nextButtonText() {
            return this.isLastQuestion() ? '完成交卷' : '下一题 →';
        },

        get displayQuestionText() {
            if (!this.currentQuestion) return '';
            const questionWithoutOldNumber = this.currentQuestion.question.replace(/^\d+\.\s*/, '');
            return `${this.currentQuestionIndex + 1}. ${questionWithoutOldNumber}`;
        },

        get sectionTitle() {
            if (!this.currentQuestion) return '';
            switch (this.currentQuestion.type) {
                case 'single':
                    return '--- 单选题 ---';
                case 'multiple':
                    return '--- 多选题 ---';
                case 'judge':
                    return '--- 判断题 ---';
                default:
                    return '';
            }
        },

        loadQuestion(index) {
            if (this.autoNextTimeout) clearTimeout(this.autoNextTimeout);
            this.isAnswerChecked = false;
            this.isCorrect = false;

            this.currentQuestionIndex = index;
            if (index < 0 || index >= this.practicePool.length) {
                this.finishTest();
                return;
            }

            this.currentQuestion = this.practicePool[index];
            this.userSelection = this.currentQuestion.type === 'multiple' ? [] : '';

            const history = this.answerHistory[index];
            if (history) {
                this.isAnswerChecked = true;
                this.isCorrect = history.isCorrect;
                this.userSelection = history.userSelection;
            }
        },

        prevQuestion() {
            if (this.currentQuestionIndex > 0) {
                this.loadQuestion(this.currentQuestionIndex - 1);
            }
        },

        moveToNextQuestion() {
            if (this.isLastQuestion()) {
                this.finishTest();
            } else {
                this.loadQuestion(this.currentQuestionIndex + 1);
            }
        },

        selectOption(selection) {
            if (this.isAnswerChecked) return;
            if (this.currentQuestion.type === 'multiple') {
                const index = this.userSelection.indexOf(selection);
                if (index > -1) {
                    this.userSelection.splice(index, 1);
                } else {
                    this.userSelection.push(selection);
                }
            } else {
                this.userSelection = selection;
            }
        },

        checkAnswerImmediately() {
            if (!this.currentQuestion || this.isAnswerChecked) return;

            if (this.currentQuestion.type === 'multiple' && this.userSelection.length === 0) {
                alert('请选择答案。');
                return;
            }
            if (this.currentQuestion.type !== 'multiple' && !this.userSelection) {
                alert('请选择答案。');
                return;
            }

            this.isAnswerChecked = true;
            let isCorrect;
            if (this.currentQuestion.type === 'multiple') {
                const userAnswerSorted = this.userSelection.sort().join('');
                const correctAnswerSorted = [...this.currentQuestion.correctAnswer].sort().join('');
                isCorrect = userAnswerSorted === correctAnswerSorted;
            } else {
                isCorrect = this.userSelection === this.currentQuestion.correctAnswer;
            }

            this.isCorrect = isCorrect;

            if (!this.answerHistory[this.currentQuestionIndex]) {
                if (isCorrect) {
                    this.stats.correct++;
                } else {
                    this.stats.incorrect++;
                    addQuestionToWrongSet(this.currentQuestion.originalData);
                }
                this.answerHistory[this.currentQuestionIndex] = {
                    userSelection: this.userSelection,
                    isCorrect: this.isCorrect
                };
            }

            if (this.isCorrect) {
                this.autoNextTimeout = setTimeout(() => {
                    this.moveToNextQuestion();
                }, 1200);
            }
        },

        getOptionClass(option) {
            if (!this.currentQuestion) return '';
            const optionChar = option.charAt(0);
            let isSelected = false;

            if (this.currentQuestion.type === 'multiple') {
                isSelected = this.userSelection.includes(optionChar);
            } else {
                isSelected = this.userSelection === optionChar;
            }

            if (this.isAnswerChecked) {
                const isCorrectAnswer = this.currentQuestion.correctAnswer.includes(optionChar);
                if (isCorrectAnswer) return 'option-label-correct';
                if (isSelected && !isCorrectAnswer) return 'option-label-incorrect';
                return '';
            } else {
                return isSelected ? 'option-label-selected' : '';
            }
        },
    }
}


document.addEventListener('alpine:init', () => {
    Alpine.data('app', () => ({
        mode: 'view',
        chapters: window.answer || [],
        allParsedQuestions: [],
        wrongQuestionCount: 0,
        brush: {},
        wrongBrush: {},
        testBrush: {},
        isDark: false,
        showScrollTop: false,
        showToc: false,
        showContinuePrompt: false,
        pendingPracticeType: null,
        showQuestionList: false,

        init() {
            this.allParsedQuestions = window.answer.flatMap(ch => ch.list)
                .map(q => parseQuestion(q))
                .filter(q => q !== null);

            this.brush = createBrushLogic(false);
            this.wrongBrush = createBrushLogic(true);
            this.testBrush = createTestLogic();

            this.brush.init(this.allParsedQuestions);
            this.wrongBrush.init();
            this.testBrush.init(this.allParsedQuestions);

            this.updateWrongCount();
            document.addEventListener('wrongset-updated', () => {
                this.updateWrongCount();
                this.wrongBrush.checkWrongSetCounts();
            });

            const savedTheme = localStorage.getItem('theme') || 'light';
            this.isDark = savedTheme === 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);

            window.addEventListener('scroll', () => this.handleScroll());

            this.$watch('showToc', value => {
                document.body.classList.toggle('overflow-hidden', value);
            });
            this.$watch('showQuestionList', value => {
                document.body.classList.toggle('overflow-hidden', value);
            });
        },

        jumpToQuestion(brushInstance, index) {
            brushInstance.loadQuestion(index);
            this.showQuestionList = false;
        },

        getQuestionStatusClass(brushInstance, index) {
            const history = brushInstance.answerHistory[index];
            if (brushInstance.currentQuestionIndex === index) {
                return 'current';
            }
            if (history) {
                return history.isCorrect ? 'correct' : 'incorrect';
            }
            return 'unanswered';
        },

        attemptToStartPractice(brushInstance, type) {
            if (this.mode === 'test') {
                brushInstance.startTest();
                return;
            }

            if (brushInstance.hasSavedProgress(type)) {
                this.pendingPracticeType = type;
                this.showContinuePrompt = true;
            } else {
                brushInstance.startPracticeByType(type);
            }
        },

        handleContinue() {
            if (this.pendingPracticeType) {
                const brushInstance = this.mode === 'brush' ? this.brush : this.wrongBrush;
                brushInstance.continuePractice(this.pendingPracticeType);
            }
            this.showContinuePrompt = false;
            this.pendingPracticeType = null;
        },

        handleRestart() {
            if (this.pendingPracticeType) {
                const brushInstance = this.mode === 'brush' ? this.brush : this.wrongBrush;
                brushInstance.startPracticeByType(this.pendingPracticeType);
            }
            this.showContinuePrompt = false;
            this.pendingPracticeType = null;
        },

        handleScroll() {
            this.showScrollTop = window.scrollY > 400;
        },

        scrollToTop() {
            window.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        },

        scrollToChapter(index) {
            const targetId = 'toc-target-' + index;
            const element = document.getElementById(targetId);
            if (element) {
                const headerOffset = 80;
                const elementPosition = element.getBoundingClientRect().top;
                const offsetPosition = elementPosition + window.pageYOffset - headerOffset;

                window.scrollTo({
                    top: offsetPosition,
                    behavior: "smooth"
                });
            }
            this.showToc = false;
        },

        toggleTheme() {
            const newTheme = this.isDark ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        },

        updateWrongCount() {
            this.wrongQuestionCount = getWrongSet().length;
        },

        setMode(newMode) {
            this.mode = newMode;
            if (newMode === 'brush') {
                this.brush.reset();
            } else if (newMode === 'wrong') {
                this.wrongBrush.reset();
            } else if (newMode === 'test') {
                this.testBrush.reset();
            }
            this.showToc = false;
            this.showQuestionList = false;
        },

        isHighlight(option, ans) {
            if (!ans || !ans.includes(':')) return false;
            let ansChar = ans.split(":")[1].trim();
            if (ansChar === '对') ansChar = 'A';
            if (ansChar === '错') ansChar = 'B';
            const optionChar = option.charAt(0);
            return ansChar.includes(optionChar);
        },
    }));
});