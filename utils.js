// --- START OF FILE utils.js ---

// =======================================================
// ================ LocalStorage 辅助函数 =================
// =======================================================

// LocalStorage 的键名常量
const WRONG_SET_KEY = 'marxism_wrong_set'; // 错题集键名
const PROGRESS_KEY_PREFIX = 'marxism_progress_'; // 练习进度键名前缀
const TEST_HISTORY_KEY = 'marxism_test_history'; // 测试历史记录键名

/**
 * 从 localStorage 获取错题集
 * @returns {Array} 错题集数组，每个元素包含 {question: Array, consecutiveCorrect: number}
 */
function getWrongSet() {
    try {
        const data = localStorage.getItem(WRONG_SET_KEY);
        if (!data) return [];
        const parsedData = JSON.parse(data);
        // 兼容旧版数据格式，将纯数组格式转换为带连续答对次数的对象格式
        return parsedData.map(item => (Array.isArray(item) ? {question: item, consecutiveCorrect: 0} : item));
    } catch (e) {
        console.error("无法从 localStorage 解析错题集", e);
        return [];
    }
}

/**
 * 保存错题集到 localStorage
 * @param {Array} set - 要保存的错题集
 */
function saveWrongSet(set) {
    localStorage.setItem(WRONG_SET_KEY, JSON.stringify(set));
    // 触发一个自定义事件，通知应用错题集已更新，以便实时更新UI
    document.dispatchEvent(new CustomEvent('wrongset-updated'));
}

/**
 * 将问题添加到错题集
 * 如果题目已存在，则重置其连续答对次数
 * @param {Array} originalQuestionArray - 原始问题数组
 */
function addQuestionToWrongSet(originalQuestionArray) {
    const wrongSet = getWrongSet();
    const questionText = originalQuestionArray[0]; // 使用题干作为唯一标识
    const itemIndex = wrongSet.findIndex(item => item.question[0] === questionText);

    if (itemIndex === -1) {
        // 如果题目不在错题集中，则添加新条目
        wrongSet.push({question: originalQuestionArray, consecutiveCorrect: 0});
    } else {
        // 如果已存在，则重置连续答对次数为0
        wrongSet[itemIndex].consecutiveCorrect = 0;
    }
    saveWrongSet(wrongSet);
}


// =======================================================
// =================== 数据解析与处理函数 ==================
// =======================================================

/**
 * 解析从 ans.js 中获取的原始问题数组为结构化对象
 * @param {Array} qArray - 原始问题数组，例如 ['题目', '选项A', '选项B', '正确答案:A']
 * @returns {Object|null} 解析后的问题对象或 null（如果格式不正确）
 */
function parseQuestion(qArray) {
    if (!Array.isArray(qArray) || qArray.length < 2) return null;
    // 过滤掉空字符串
    const cleanArray = qArray.filter(item => typeof item === 'string' && item.trim() !== '');
    if (cleanArray.length < 2) return null;

    // 查找并解析答案行
    const answerLine = cleanArray.find(line => line.startsWith('正确答案:'));
    if (!answerLine) return null;
    const answerIndex = cleanArray.indexOf(answerLine);
    let correctAnswer = answerLine.split(':')[1]?.trim();
    if (!correctAnswer) return null;

    // 解析题目类型
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
        // 判断题特殊处理
        question = mainQuestionLine;
        options = ['A. 对', 'B. 错'];
        if (correctAnswer === '对') correctAnswer = 'A';
        if (correctAnswer === '错') correctAnswer = 'B';
    } else {
        // 单选题和多选题处理
        const firstOptionIndex = cleanArray.findIndex(line => /^[A-Z]\./.test(line.trim()));
        if (firstOptionIndex === -1 || firstOptionIndex >= answerIndex) {
            return null; // 找不到选项或选项在答案之后
        }
        const questionLines = cleanArray.slice(0, firstOptionIndex);
        question = questionLines.join('\n'); // 支持多行题目
        options = cleanArray.slice(firstOptionIndex, answerIndex);
    }

    if (options.length === 0) return null;

    return {
        question: question,
        options: options,
        type: type,
        correctAnswer: correctAnswer,
        originalData: qArray // 保留原始数据，用于后续查找解析等操作
    };
}

/**
 * 随机打乱数组（Fisher-Yates 洗牌算法）
 * @param {Array} array - 需要打乱的数组
 * @returns {Array} 打乱后的数组
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}


// =======================================================
// ================= 刷题/错题练习核心逻辑 =================
// =======================================================

/**
 * 创建一个刷题逻辑控制器
 * @param {boolean} isWrongSetMode - 是否为错题集模式
 * @returns {Object} 刷题逻辑控制器实例
 */
function createBrushLogic(isWrongSetMode = false) {
    const modeIdentifier = isWrongSetMode ? 'wrong_' : 'normal_'; // 模式标识，用于区分localStorage键
    return {
        allQuestions: [], // 全部问题源
        practicePool: [], // 当前练习的题库
        currentQuestionIndex: -1, // 当前题目索引
        currentQuestion: null, // 当前题目对象
        userSelection: null, // 用户答案
        isPracticeStarted: false, // 练习是否开始
        isAnswerChecked: false, // 当前题目是否已检查答案
        isCorrect: false, // 当前题目是否回答正确
        stats: {correct: 0, incorrect: 0, total: 0}, // 统计数据
        autoNextTimeout: null, // 自动下一题的定时器
        counts: {single: 0, multiple: 0, judge: 0, total: 0}, // 错题模式下的各题型数量
        isEmpty: true, // 错题库是否为空
        answerHistory: {}, // 答题历史记录 {index: {userSelection, isCorrect}}
        practiceType: null, // 当前练习的类型 ('single', 'multiple', 'judge', 'all')

        /** 检查是否有指定类型的未完成练习进度 */
        hasSavedProgress(type) {
            return localStorage.getItem(PROGRESS_KEY_PREFIX + modeIdentifier + type) !== null;
        },

        /** 保存当前练习进度 */
        saveProgress() {
            if (!this.isPracticeStarted || !this.practiceType || this.currentQuestion === null) return;
            const state = {
                practicePool: this.practicePool,
                currentQuestionIndex: this.currentQuestionIndex,
                stats: this.stats,
                answerHistory: this.answerHistory,
            };
            localStorage.setItem(PROGRESS_KEY_PREFIX + modeIdentifier + this.practiceType, JSON.stringify(state));
        },

        /** 清除练习进度 */
        clearProgress(type = null) {
            const progressType = type || this.practiceType;
            if (progressType) {
                localStorage.removeItem(PROGRESS_KEY_PREFIX + modeIdentifier + progressType);
            }
        },

        /** 继续上次的练习 */
        continuePractice(type) {
            const savedStateJSON = localStorage.getItem(PROGRESS_KEY_PREFIX + modeIdentifier + type);
            if (!savedStateJSON) return;
            const savedState = JSON.parse(savedStateJSON);
            this.practicePool = savedState.practicePool;
            this.stats = savedState.stats;
            this.answerHistory = savedState.answerHistory;
            this.isPracticeStarted = true;
            this.practiceType = type;
            this.loadQuestion(savedState.currentQuestionIndex);
        },

        /** 计算属性：获取当前用于显示的题干文本 */
        get displayQuestionText() {
            if (!this.currentQuestion) return '';
            const questionWithoutOldNumber = this.currentQuestion.question.replace(/^\d+\.\s*/, '');
            return `${this.currentQuestionIndex + 1}. ${questionWithoutOldNumber}`;
        },

        /** 计算属性：获取当前题目的分区标题 */
        get sectionTitle() {
            if (!this.currentQuestion) return '';
            switch (this.currentQuestion.type) {
                case 'single': return '--- 单选题 ---';
                case 'multiple': return '--- 多选题 ---';
                case 'judge': return '--- 判断题 ---';
                default: return '';
            }
        },

        /** 初始化刷题逻辑 */
        init(allParsedQuestions = null) {
            this.allQuestions = allParsedQuestions || [];
            if (isWrongSetMode) {
                this.checkWrongSetCounts(); // 如果是错题模式，检查错题数量
            }
        },

        /** 重置刷题状态 */
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

        /** 检查并更新错题集中的各题型数量 */
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

        /** 根据类型开始练习 */
        startPracticeByType(type) {
            this.clearProgress(type); // 开始新练习前清除旧进度
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

        /** 开始练习（通用部分） */
        startPractice() {
            this.isPracticeStarted = true;
            this.currentQuestionIndex = -1;
            this.stats.correct = 0;
            this.stats.incorrect = 0;
            this.answerHistory = {};
            this.loadQuestion(0); // 从第一题开始
        },

        /** 加载指定索引的题目 */
        loadQuestion(index) {
            if (this.autoNextTimeout) clearTimeout(this.autoNextTimeout);
            this.isAnswerChecked = false;
            this.isCorrect = false;
            this.currentQuestionIndex = index;

            if (index < 0 || index >= this.practicePool.length) {
                this.currentQuestion = null; // 练习结束
                this.clearProgress();
                return;
            }

            this.currentQuestion = this.practicePool[index];
            this.userSelection = this.currentQuestion.type === 'multiple' ? [] : '';

            // 检查是否有历史记录，如有则恢复答题状态
            const history = this.answerHistory[index];
            if (history) {
                this.isAnswerChecked = true;
                this.isCorrect = history.isCorrect;
                this.userSelection = history.userSelection;
            }
            this.saveProgress();
        },

        /** 上一题 */
        prevQuestion() {
            if (this.currentQuestionIndex > 0) {
                this.loadQuestion(this.currentQuestionIndex - 1);
            }
        },

        /** 下一题 */
        nextQuestion() {
            if (this.currentQuestionIndex >= this.practicePool.length - 1) {
                this.currentQuestion = null; // 练习结束
                this.clearProgress();
            } else {
                this.loadQuestion(this.currentQuestionIndex + 1);
            }
        },

        /** 单选题和判断题：选择并立即检查 */
        selectAndCheck(selection) {
            if (this.isAnswerChecked) return;
            this.userSelection = selection;
            this.checkAnswer(true);
        },

        /** 检查答案 */
        checkAnswer(isAutoCheck = false) {
            if (!this.currentQuestion || this.isAnswerChecked) return;
            // 多选题必须有选择
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

            // 如果是第一次回答此题，则更新统计数据
            if (!this.answerHistory[this.currentQuestionIndex]) {
                if (isCorrect) this.stats.correct++; else this.stats.incorrect++;
                if (!isWrongSetMode && !isCorrect) {
                    addQuestionToWrongSet(this.currentQuestion.originalData);
                }
            }

            // 错题集模式下的特殊逻辑
            if (isWrongSetMode) {
                const wrongSet = getWrongSet();
                const itemIndex = wrongSet.findIndex(item => item.question[0] === this.currentQuestion.question);
                if (itemIndex > -1) {
                    if (isCorrect) {
                        // 如果本次答对，且之前未记录为答对，则连续答对次数+1
                        if (this.answerHistory[this.currentQuestionIndex]?.isCorrect !== true) {
                            wrongSet[itemIndex].consecutiveCorrect = (wrongSet[itemIndex].consecutiveCorrect || 0) + 1;
                            // 连续答对3次则从错题集移除
                            if (wrongSet[itemIndex].consecutiveCorrect >= 3) {
                                wrongSet.splice(itemIndex, 1);
                            }
                        }
                    } else {
                        // 答错则重置连续答对次数
                        wrongSet[itemIndex].consecutiveCorrect = 0;
                    }
                    saveWrongSet(wrongSet);
                }
            }

            this.answerHistory[this.currentQuestionIndex] = {
                userSelection: this.userSelection,
                isCorrect: this.isCorrect
            };
            this.saveProgress();

            // 如果是单选/判断且答对，自动跳转到下一题
            if (isAutoCheck && this.currentQuestion.type !== 'multiple' && this.isCorrect) {
                this.autoNextTimeout = setTimeout(() => this.nextQuestion(), 1200);
            }
        },

        /** 获取选项的CSS类，用于高亮正确/错误/选中状态 */
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


// =======================================================
// =================== 模拟测试核心逻辑 ===================
// =======================================================

/**
 * 创建一个模拟测试逻辑控制器
 * @returns {Object} 模拟测试逻辑控制器实例
 */
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
        stats: {correct: 0, incorrect: 0, total: 100}, // 总题数固定为100
        answerHistory: {},
        history: [], // 测试历史记录
        timerInterval: null,
        startTime: 0,
        elapsedTime: 0,
        formattedTime: '00:00',
        lastTestResult: null,
        autoNextTimeout: null,

        /** 初始化，加载题库和历史记录 */
        init(allParsedQuestions) {
            this.allQuestions = allParsedQuestions;
            this.loadHistory();
        },

        /** 从localStorage加载测试历史 */
        loadHistory() {
            const data = localStorage.getItem(TEST_HISTORY_KEY);
            this.history = data ? JSON.parse(data) : [];
        },

        /** 保存测试历史到localStorage */
        saveHistory() {
            localStorage.setItem(TEST_HISTORY_KEY, JSON.stringify(this.history));
        },

        /** 开始计时器 */
        startTimer() {
            this.startTime = Date.now() - this.elapsedTime;
            this.timerInterval = setInterval(() => {
                this.elapsedTime = Date.now() - this.startTime;
                this.formattedTime = this.formatDuration(this.elapsedTime / 1000);
            }, 1000);
        },

        /** 停止计时器 */
        stopTimer() {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
        },

        /** 格式化时长为 mm:ss 或 hh:mm:ss */
        formatDuration(seconds) {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            const pad = (num) => num.toString().padStart(2, '0');
            if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
            return `${pad(m)}:${pad(s)}`;
        },

        /** 重置测试状态 */
        reset() {
            this.stopTimer();
            if (this.autoNextTimeout) clearTimeout(this.autoNextTimeout);
            this.isPracticeStarted = false;
            this.currentQuestion = null;
            this.answerHistory = {};
            this.lastTestResult = null;
            this.loadHistory();
        },

        /** 开始一次新测试 */
        startTest() {
            // 固定题型数量
            const counts = {single: 50, multiple: 30, judge: 20};
            this.stats.total = counts.single + counts.multiple + counts.judge;
            const singles = shuffleArray(this.allQuestions.filter(q => q.type === 'single')).slice(0, counts.single);
            const multiples = shuffleArray(this.allQuestions.filter(q => q.type === 'multiple')).slice(0, counts.multiple);
            const judges = shuffleArray(this.allQuestions.filter(q => q.type === 'judge')).slice(0, counts.judge);
            this.practicePool = [...singles, ...multiples, ...judges];
            this.stats.total = this.practicePool.length; // 如果题库不足，以实际数量为准

            if (this.stats.total === 0) {
                alert("题库为空，无法开始测试！");
                return;
            }

            // 初始化测试状态
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

        /** 结束测试并保存结果 */
        finishTest() {
            this.stopTimer();
            this.currentQuestion = null;

            const answeredCount = Object.keys(this.answerHistory).length;
            const accuracy = answeredCount > 0
                ? ((this.stats.correct / answeredCount) * 100).toFixed(2) + '%'
                : '0.00%';

            const result = {
                id: Date.now(),
                date: new Date().toLocaleString(),
                stats: {...this.stats},
                answeredCount: answeredCount, // 记录实际答题数
                duration: this.elapsedTime,
                formattedDuration: this.formatDuration(this.elapsedTime / 1000),
                accuracy: accuracy
            };

            this.lastTestResult = result;
            this.history.unshift(result); // 新记录插到最前面
            this.saveHistory();
        },

        /** 判断是否是最后一题 */
        isLastQuestion() {
            return this.currentQuestionIndex === this.practicePool.length - 1;
        },

        /** 计算属性：获取下一题按钮的文本 */
        get nextButtonText() {
            return this.isLastQuestion() ? '完成交卷' : '下一题 →';
        },

        /** 计算属性：获取当前用于显示的题干文本 */
        get displayQuestionText() {
            if (!this.currentQuestion) return '';
            const questionWithoutOldNumber = this.currentQuestion.question.replace(/^\d+\.\s*/, '');
            return `${this.currentQuestionIndex + 1}. ${questionWithoutOldNumber}`;
        },

        /** 计算属性：获取当前题目的分区标题 */
        get sectionTitle() {
            if (!this.currentQuestion) return '';
            switch (this.currentQuestion.type) {
                case 'single': return '--- 单选题 ---';
                case 'multiple': return '--- 多选题 ---';
                case 'judge': return '--- 判断题 ---';
                default: return '';
            }
        },

        /** 加载指定索引的题目 */
        loadQuestion(index) {
            if (this.autoNextTimeout) clearTimeout(this.autoNextTimeout);
            this.isAnswerChecked = false;
            this.isCorrect = false;

            this.currentQuestionIndex = index;
            if (index < 0 || index >= this.practicePool.length) {
                this.finishTest(); // 所有题目答完，结束测试
                return;
            }

            this.currentQuestion = this.practicePool[index];
            this.userSelection = this.currentQuestion.type === 'multiple' ? [] : '';

            // 恢复历史记录
            const history = this.answerHistory[index];
            if (history) {
                this.isAnswerChecked = true;
                this.isCorrect = history.isCorrect;
                this.userSelection = history.userSelection;
            }
        },

        /** 上一题 */
        prevQuestion() {
            if (this.currentQuestionIndex > 0) {
                this.loadQuestion(this.currentQuestionIndex - 1);
            }
        },

        /** 移动到下一题或结束测试 */
        moveToNextQuestion() {
            if (this.isLastQuestion()) {
                this.finishTest();
            } else {
                this.loadQuestion(this.currentQuestionIndex + 1);
            }
        },

        /** 选择选项（多选题支持增删） */
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

        /** 提交答案并立即检查 */
        checkAnswerImmediately() {
            if (!this.currentQuestion || this.isAnswerChecked) return;
            // 检查是否有选择
            if ((this.currentQuestion.type === 'multiple' && this.userSelection.length === 0) || (this.currentQuestion.type !== 'multiple' && !this.userSelection)) {
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

            // 如果是第一次回答，更新统计和错题集
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

            // 如果答对，自动跳转
            if (this.isCorrect) {
                this.autoNextTimeout = setTimeout(() => {
                    this.moveToNextQuestion();
                }, 1200);
            }
        },

        /** 获取选项的CSS类，用于高亮正确/错误/选中状态 */
        getOptionClass(option) {
            if (!this.currentQuestion) return '';
            const optionChar = option.charAt(0);
            let isSelected = false;

            if (this.currentQuestion.type === 'multiple') {
                isSelected = this.userSelection.includes(optionChar);
            } else {
                isSelected = this.userSelection === optionChar;
            }

            if (this.isAnswerChecked) { // 已提交答案
                const isCorrectAnswer = this.currentQuestion.correctAnswer.includes(optionChar);
                if (isCorrectAnswer) return 'option-label-correct';
                if (isSelected && !isCorrectAnswer) return 'option-label-incorrect';
                return '';
            } else { // 未提交答案
                return isSelected ? 'option-label-selected' : '';
            }
        },
    }
}


// =======================================================
// ================= 页面加载与入口动画逻辑 =================
// =======================================================

/**
 * 页面加载完成时执行的初始化脚本
 */
document.addEventListener("DOMContentLoaded", () => {
    const text = "Power By muyu && Leessmin";
    const element = document.getElementById("typing-text");
    let i = 0;

    // 打字机效果函数
    function typeWriter() {
        if (i < text.length) {
            element.innerHTML += text.charAt(i);
            i++;
            setTimeout(typeWriter, 60);
        } else {
            element.style.borderRight = "none"; // 打字完成后隐藏光标
        }
    }

    typeWriter();

    // 2秒后显示 "点击进入" 提示，并绑定事件
    setTimeout(() => {
        const enterText = document.querySelector("#enterText");
        const loadMark = document.querySelector("#loadMark");

        if(enterText) enterText.style.color = "white";

        // 关闭加载页的函数
        const closeLoadMarkFn = () => {
            document.body.style.overflow = "auto";
            // 如果浏览器支持 View Transitions API，则使用平滑过渡
            if (document.startViewTransition) {
                document.startViewTransition(() => {
                    if(loadMark) loadMark.style.display = "none";
                });
            } else {
                if(loadMark) loadMark.style.display = "none";
            }
        };

        // 为加载页绑定点击和触摸事件
        if(loadMark) {
            loadMark.addEventListener('click', closeLoadMarkFn);
            loadMark.addEventListener('touchend', closeLoadMarkFn);
        }
    }, 2000);
});


// =======================================================
// ================== Alpine.js 应用主逻辑 =================
// =======================================================

/**
 * 初始化 Alpine.js 应用
 */
document.addEventListener('alpine:init', () => {
    // 定义名为 'app' 的 Alpine 数据组件
    Alpine.data('app', () => ({
        // --- 状态属性 ---
        mode: 'view', // 当前模式: 'view', 'brush', 'test', 'wrong'
        chapters: window.answer || [], // 题库章节数据
        allParsedQuestions: [], // 解析后的所有题目
        wrongQuestionCount: 0, // 错题数量
        brush: {}, // 随机刷题控制器实例
        wrongBrush: {}, // 错题练习控制器实例
        testBrush: {}, // 模拟测试控制器实例
        analysisMap: {}, // 题目与解析的映射表 {'题目': '解析'}
        isDark: false, // 是否为暗黑模式
        showScrollTop: false, // 是否显示“回到顶部”按钮
        showToc: false, // 是否显示目录
        showContinuePrompt: false, // 是否显示“继续练习”弹窗
        pendingPracticeType: null, // 待开始的练习类型
        showQuestionList: false, // 是否显示题目列表面板

        // --- 解析弹窗相关状态 ---
        showAnalysisModal: false, // 控制解析弹窗的显示
        currentAnalysisContent: '', // 当前弹窗中显示的解析内容

        // --- 初始化方法 ---
        init() {
            // 1. 解析所有题目
            this.allParsedQuestions = window.answer.flatMap(ch => ch.list)
                .map(q => parseQuestion(q))
                .filter(q => q !== null);

            // 2. 构建题目到解析的映射表
            if (window.analysis) {
                window.analysis.forEach(chapter => {
                    chapter.list.forEach(analysisItem => {
                        if(analysisItem.length >= 2) {
                            this.analysisMap[analysisItem[0]] = analysisItem[1];
                        }
                    });
                });
            }

            // 3. 初始化各种模式的控制器
            this.brush = createBrushLogic(false);
            this.wrongBrush = createBrushLogic(true);
            this.testBrush = createTestLogic();
            this.brush.init(this.allParsedQuestions);
            this.wrongBrush.init();
            this.testBrush.init(this.allParsedQuestions);

            // 4. 监听错题集更新事件
            this.updateWrongCount();
            document.addEventListener('wrongset-updated', () => {
                this.updateWrongCount();
                this.wrongBrush.checkWrongSetCounts();
            });

            // 5. 初始化主题
            const savedTheme = localStorage.getItem('theme') || 'light';
            this.isDark = savedTheme === 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);

            // 6. 监听滚动和侧边栏状态
            window.addEventListener('scroll', () => this.handleScroll());
            this.$watch('showToc', value => { document.body.classList.toggle('overflow-hidden', value); });
            this.$watch('showQuestionList', value => { document.body.classList.toggle('overflow-hidden', value); });
            this.$watch('showAnalysisModal', value => { document.body.classList.toggle('overflow-hidden', value); }); // 弹窗显示时禁止背景滚动
        },

        // --- 辅助方法 ---

        /** 获取当前题目的解析 */
        getCurrentAnalysis(brushInstance) {
            if (!brushInstance.currentQuestion?.originalData) return null;
            const questionKey = brushInstance.currentQuestion.originalData[0];
            return this.analysisMap[questionKey] || null;
        },

        /** 从题目列表跳转到指定题目 */
        jumpToQuestion(brushInstance, index) {
            brushInstance.loadQuestion(index);
            this.showQuestionList = false;
        },

        /** 获取题目列表项的CSS类 */
        getQuestionStatusClass(brushInstance, index) {
            const history = brushInstance.answerHistory[index];
            if (brushInstance.currentQuestionIndex === index) return 'current';
            if (history) return history.isCorrect ? 'correct' : 'incorrect';
            return 'unanswered';
        },

        // --- 解析弹窗相关方法 ---

        /** 打开解析弹窗 */
        openAnalysisModal(analysis) {
            if (analysis) {
                this.currentAnalysisContent = analysis;
                this.showAnalysisModal = true;
            }
        },

        /** 关闭解析弹窗 */
        closeAnalysisModal() {
            this.showAnalysisModal = false;
        },

        // --- 事件处理方法 ---

        /** 尝试开始一个练习 */
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

        /** 处理“继续练习” */
        handleContinue() {
            if (this.pendingPracticeType) {
                const brushInstance = this.mode === 'brush' ? this.brush : this.wrongBrush;
                brushInstance.continuePractice(this.pendingPracticeType);
            }
            this.showContinuePrompt = false;
            this.pendingPracticeType = null;
        },

        /** 处理“重新开始” */
        handleRestart() {
            if (this.pendingPracticeType) {
                const brushInstance = this.mode === 'brush' ? this.brush : this.wrongBrush;
                brushInstance.startPracticeByType(this.pendingPracticeType);
            }
            this.showContinuePrompt = false;
            this.pendingPracticeType = null;
        },

        handleScroll() { this.showScrollTop = window.scrollY > 400; },
        scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); },
        scrollToChapter(index) {
            const targetId = 'toc-target-' + index;
            const element = document.getElementById(targetId);
            if (element) {
                const headerOffset = 80;
                const elementPosition = element.getBoundingClientRect().top;
                const offsetPosition = elementPosition + window.pageYOffset - headerOffset;
                window.scrollTo({ top: offsetPosition, behavior: "smooth" });
            }
            this.showToc = false;
        },

        toggleTheme() {
            const newTheme = this.isDark ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        },

        updateWrongCount() { this.wrongQuestionCount = getWrongSet().length; },

        setMode(newMode) {
            this.mode = newMode;
            if (newMode === 'brush') this.brush.reset();
            else if (newMode === 'wrong') this.wrongBrush.reset();
            else if (newMode === 'test') this.testBrush.reset();
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